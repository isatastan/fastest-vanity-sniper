"use strict";
process.env.UV_THREADPOOL_SIZE = 256;
try {
  process.setpriority(process.pid, -20);
  if (process.platform === "win32") {
    require("child_process").execSync(
      `powershell "Get-Process -Id ${process.pid} | ForEach-Object { $_.PriorityClass = 'RealTime' }"`
    );
    require("child_process").execSync(
      `powershell "$Process = Get-Process -Id ${process.pid}; $Process.ProcessorAffinity = 1"`
    );
  }
} catch {}

const http2 = require("http2");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const token = ""; // token
const swid = "1420792516227371008"; // guild id

let vanity, websocket, mfaToken;
const guilds = {};
const http2Sessions = [];

function loadMfaToken() {
  try {
    const data = fs.readFileSync(path.join(__dirname, "mfa.txt"), "utf8").trim();
    if (data && data !== mfaToken) {
      mfaToken = data;
      console.log("mfa gecildi");
    }
    return true;
  } catch {
    return false;
  }
}

function createHttp2Session() {
  const session = http2.connect("https://canary.discord.com");
  session.on("connect", () => {
    if (!http2Sessions.includes(session)) {
      http2Sessions.push(session);
    }
  });
  session.on("error", () => reconnectSession(session));
  session.on("close", () => reconnectSession(session));
  return session;
}

function reconnectSession(session) {
  const idx = http2Sessions.indexOf(session);
  if (idx !== -1) http2Sessions.splice(idx, 1);
  createHttp2Session();
}

function initSessions() {
  http2Sessions.push(createHttp2Session());
  http2Sessions.push(createHttp2Session());
  http2Sessions.push(createHttp2Session());
  http2Sessions.push(createHttp2Session());
  console.log("ready eventi geldi h2 session sayisi:", http2Sessions.length);
}

function getAvailableSession() {
  return http2Sessions.find(
    (session) =>
      !session.destroyed && !session.closed && session.state.localWindowSize > 0
  );
}

function patchVanityUrl(vanityCode) {
  return new Promise((resolve, reject) => {
    const session = getAvailableSession();
    if (!session) return reject(new Error("h2 oturumlari uygun degil"));
    const payload = JSON.stringify({ code: vanityCode });
    const req = session.request(
      {
        ":method": "PATCH",
        ":path": `/api/v8/guilds/${swid}/vanity-url`,
        ":scheme": "https",
        ":authority": "canary.discord.com",
        authorization: token,
        "x-discord-mfa-authorization": mfaToken,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "x-super-properties":
          "eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ==",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
      {
        weight: 256,
        parent: 0,
        exclusive: true,
      }
    );

    let responseData = "";
    req.on("data", (chunk) => (responseData += chunk));
    req.on("end", () => {
      try {
        const response = JSON.parse(responseData);
        if (response.code || response.message) {
          console.log(`${JSON.stringify(response)}`);
          if (response.code && response.code !== 200) {
            reject(new Error("basarisiz patch"));
          } else {
            resolve();
          }
        } else {
          resolve();
        }
      } catch {
        resolve();
      }
    });
    req.on("error", () => reject(new Error("hata")));
    req.write(payload);
    req.end();
  });
}

async function sendPatchRequests(vanityCode) {
  await Promise.all(
    Array(5)
      .fill(0)
      .map(() => patchVanityUrl(vanityCode))
  ).catch(() => {});
}

function connectWebSocket() {
  websocket = new WebSocket("wss://gateway-us-east1-b.discord.gg", {
    perMessageDeflate: false,
  });

  websocket.onclose = () => setTimeout(connectWebSocket, 500); 
  websocket.onerror = () => {};

  websocket.onmessage = async ({ data }) => {
    const { d, op, t } = JSON.parse(data);

    if (op === 10) {
      websocket.send(
        JSON.stringify({
          op: 2,
          d: {
            token,
            intents: 1 << 0,
            properties: {
              os: "",
              browser: "",
              device: "",
            },
          },
        })
      );

      setInterval(() => {
        if (websocket.readyState === WebSocket.OPEN) {
          websocket.send(JSON.stringify({ op: 1, d: {} }));
        }
      }, d.heartbeat_interval);
    }

    if (t === "READY") {
      for (const g of d.guilds) {
        if (g.vanity_url_code) guilds[g.id] = g.vanity_url_code;
      }
    }

    if (t === "GUILD_UPDATE" && d) {
      if (guilds[d.guild_id] && guilds[d.guild_id] !== d.vanity_url_code) {
        const oldVanity = guilds[d.guild_id];
        guilds[d.guild_id] = d.vanity_url_code;
        if (!loadMfaToken()) return;
        sendPatchRequests(oldVanity).catch(() => {});
      }
    }
  };
}

setInterval(() => {
  http2Sessions.forEach((session) => {
    if (!session.destroyed && !session.closed) {
      const pingReq = session.request({
        ":method": "HEAD",
        ":path": "/api/v8/users/@me",
        ":scheme": "https",
        ":authority": "canary.discord.com",
        authorization: token,
      });
      pingReq.on("error", () => {});
      pingReq.end();
    }
  });
}, 10000);

function initialize() {
  loadMfaToken();
  initSessions();
  connectWebSocket();
  setInterval(loadMfaToken, 5000);
}
initialize();
