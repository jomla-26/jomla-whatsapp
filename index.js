/**
 * سيرفس واتساب مستقل لجملة — يستخدم مكتبة Baileys (مجانية، بدون حساب Business API)
 * يتصل برقم واتساب عادي عن طريق مسح كود QR مرة واحدة، ويبقى متصل بعدها.
 *
 * نقاط الوصول:
 *   GET  /qr      — يعرض كود QR كصورة لمسحه من الهاتف (أول مرة فقط، أو بعد قطع الاتصال)
 *   GET  /status  — يوريك حالة الاتصال الحالية
 *   POST /send    — يبعت رسالة واتساب (نص، أو رابط PDF مرفق)، محمي بمفتاح سري
 */
import express from "express";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

const PORT = process.env.PORT || 8090;
const SECRET_KEY = process.env.WHATSAPP_SECRET_KEY; // لازم تتطابق مع المفتاح اللي في jomla-api
const AUTH_DIR = process.env.AUTH_DIR || "./auth"; // لازم يكون على Railway Volume عشان ما يضيعش

if (!SECRET_KEY) {
  console.error("خطأ: لازم تحدد WHATSAPP_SECRET_KEY في متغيرات البيئة قبل التشغيل");
  process.exit(1);
}

const app = express();
app.use(express.json());

let sock = null;
let latestQr = null;
let connectionStatus = "starting"; // starting | qr_pending | connected | disconnected

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      connectionStatus = "qr_pending";
      console.log("كود QR جديد جاهز — افتح /qr في المتصفح وامسحه من واتساب");
    }

    if (connection === "open") {
      connectionStatus = "connected";
      latestQr = null;
      console.log("✅ متصل بواتساب بنجاح");
    }

    if (connection === "close") {
      connectionStatus = "disconnected";
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("انقطع الاتصال، إعادة المحاولة:", shouldReconnect);
      if (shouldReconnect) startSocket();
    }
  });
}

startSocket().catch((err) => {
  console.error("فشل تشغيل سيرفس واتساب:", err);
});

/* ------------------------------ نقاط الوصول ------------------------------ */

app.get("/status", (_req, res) => {
  res.json({ status: connectionStatus });
});

app.get("/qr", async (_req, res) => {
  if (connectionStatus === "connected") {
    return res.send("<h2 style='font-family:sans-serif'>✅ متصل بالفعل — لا حاجة لمسح كود جديد</h2>");
  }
  if (!latestQr) {
    return res.send("<h2 style='font-family:sans-serif'>جارٍ التحضير… أعد تحميل الصفحة بعد ثوانٍ</h2>");
  }
  const dataUrl = await QRCode.toDataURL(latestQr, { width: 320 });
  res.send(`
    <html dir="rtl"><body style="display:flex;flex-direction:column;align-items:center;
      font-family:sans-serif;padding:40px;background:#111;color:#fff">
      <h2>افتح واتساب على هاتف رقم جملة ← الأجهزة المرتبطة ← ربط جهاز</h2>
      <p>وامسح الكود ده:</p>
      <img src="${dataUrl}" style="border:8px solid #fff;border-radius:8px"/>
      <p style="margin-top:20px;color:#999">الصفحة تتحدث تلقائيًا كل 20 ثانية</p>
      <script>setTimeout(() => location.reload(), 20000)</script>
    </body></html>
  `);
});

function checkSecret(req, res, next) {
  const key = req.headers["x-secret-key"];
  if (key !== SECRET_KEY) {
    return res.status(401).json({ error: "مفتاح غير صحيح" });
  }
  next();
}

// ينظف رقم الهاتف الليبي ويحوله لصيغة واتساب الدولية (2189XXXXXXXX@s.whatsapp.net)
function toWhatsappId(rawPhone) {
  let p = String(rawPhone).replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0")) p = "218" + p.slice(1);
  if (!p.startsWith("218")) p = "218" + p;
  return `${p}@s.whatsapp.net`;
}

app.post("/send", checkSecret, async (req, res) => {
  const { phone, message, pdfUrl, pdfFilename } = req.body || {};

  if (connectionStatus !== "connected") {
    return res.status(503).json({ error: "سيرفس واتساب غير متصل حاليًا — راجع /status" });
  }
  if (!phone || !message) {
    return res.status(400).json({ error: "الحقول phone و message مطلوبة" });
  }

  try {
    const jid = toWhatsappId(phone);

    if (pdfUrl) {
      await sock.sendMessage(jid, {
        document: { url: pdfUrl },
        mimetype: "application/pdf",
        fileName: pdfFilename || "document.pdf",
        caption: message,
      });
    } else {
      await sock.sendMessage(jid, { text: message });
    }

    res.json({ sent: true });
  } catch (err) {
    console.error("فشل إرسال رسالة واتساب:", err);
    res.status(500).json({ error: "فشل إرسال الرسالة", details: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`سيرفس واتساب شغال على المنفذ ${PORT}`);
});
