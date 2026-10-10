# Receipt Photo Booth — Project Brief

## สถานะปัจจุบัน (สำคัญมาก อ่านก่อนเริ่ม)

- **เฟสนี้ยังไม่มีระบบจ่ายเงิน** ตู้ให้ใช้ฟรีทั้งหมด เพื่อเอาไป promote/ทดสอบให้คนรู้จักก่อน — **ห้ามเขียนโค้ดส่วน Payment/QR จ่ายเงินตอนนี้** flow เริ่มจากเลือกจำนวนใบ/เลือกกรอบ แล้วข้ามไปถ่ายรูปได้เลย (ไม่มีขั้นตอนรอจ่ายเงิน)
- **เครือข่าย: ย้ายมาใช้เราเตอร์ TP-Link TL-MR105 แล้ว (2026-10-11)** — Pi ต่อเราเตอร์ด้วยสาย LAN (ได้ IP จาก DHCP), iPad ต่อ WiFi ของเราเตอร์ เปิดตู้ด้วยชื่อ `photobooth-pi.local` เหมือนเดิม ค่า iPhone Hotspot ยังบันทึกอยู่ใน Pi เป็นทางสำรอง (ถอดสาย LAN + เปิด Hotspot แล้วใช้ได้เลย) **อย่า hardcode SSID/IP ในโค้ด** ให้ตั้งค่าผ่าน environment variable หรือไฟล์ config แยกแทน **ข้อควรรู้ของเราเตอร์ตัวนี้:** DNS ของมันไม่ตอบคำถามแบบ IPv6 (AAAA) สำหรับ `api.cloudinary.com` ทำให้การหาที่อยู่แบบปกติค้าง ~15 วินาที — `services/storage.js` จึงบังคับ IPv4 ตอนอัพโหลด ถ้าเพิ่มบริการภายนอกตัวใหม่ (เช่น LINE Messaging API) ให้เช็คเรื่องนี้ด้วย
- **ที่เก็บรูปจริงคือ Cloudinary ไม่ใช่ Firebase** (โค้ดอยู่ที่ `services/storage.js` แพ็กเกจ Free 25 เครดิต/เดือน) — ส่วนที่เอกสารนี้ยังเขียนว่า Firebase เป็นแผนเดิม ยังไม่ได้ทำ signed URL/ลบรูปอัตโนมัติตามข้อ 7
- **คลิปวิดีโอเบื้องหลัง (ทดลอง, ปิดอยู่):** โค้ดมีแล้ว อัดวิดีโอช่วงนับถอยหลังแล้วให้โหลดผ่าน QR อันที่สาม เปิดด้วย `VIDEO_CLIP=true` ใน `.env` แล้ว `pm2 restart photobooth` (iPad ต้องรีโหลดหน้าด้วย) เจ้าของลองแล้วเมื่อ 2026-10-11 และขอปิดไว้ก่อน
- คนเขียนโค้ด (เจ้าของเครื่อง) เป็นมือใหม่ พื้นฐาน JavaScript/HTML/CSS อธิบายละเอียด ไม่ต้องสมมติว่ารู้ศัพท์เทคนิคมาก่อน
- **ตอบเป็นภาษาไทยเสมอทุกข้อความ** (ตั้งแต่ 2026-09-19) ไม่ว่าจะเป็นคำอธิบาย บทสนทนา หรือสรุปงาน — ยกเว้นชื่อไฟล์/โค้ด/คำสั่ง/ศัพท์เทคนิคที่ไม่มีคำแปลไทยที่เป็นธรรมชาติ ให้คงเป็นภาษาอังกฤษได้ตามเดิม
- **⚠️ เตือนเจ้าของเมื่อพูดถึงการเอาตู้ไปตั้ง/ใช้งานจริง (ขอไว้เมื่อ 2026-10-03):** ต้อง **เปิด Guided Access** บน iPad ก่อนเปิดให้ลูกค้าใช้ (การตั้งค่า → การช่วยการเข้าถึง → Guided Access แล้วกดปุ่มด้านบน 3 ครั้งตอนอยู่ในแอปตู้) เพื่อกันลูกค้าออกจากแอป — ดูรายละเอียดข้อ 11 ด้านล่าง เตือนทุกครั้งที่เรื่องนี้เกี่ยวข้องจนกว่าเจ้าของจะบอกว่าทำแล้ว (อีกข้อที่เคยต้องเตือนคือสมัคร Kiosker Premium เพื่อเอาป้ายลายน้ำออก — **เจ้าของบอกว่าสมัครแล้วเมื่อ 2026-10-10 ไม่ต้องเตือนเรื่องนี้อีก**)

## Concept

ตู้ถ่ายรูปขนาดเล็กสไตล์ "Receipt Photobooth" ในตู้ไม้ดีไซน์สวยงาม ใช้ iPad เป็นกล้อง+จอสัมผัส ถ่าย **รูปเดียวต่อครั้ง** (ไม่ใช่แถบหลายรูป) ลูกค้าเลือกจำนวนใบพิมพ์และลายกรอบก่อนถ่าย พิมพ์ออกมาเป็นใบเสร็จขาวดำ (dithering) พร้อม QR โหลดรูปสีเก็บมือถือ

Positioning: "เครื่องพิมพ์ความทรงจำเป็นใบเสร็จ" ไม่ใช่แค่ photo booth ทั่วไป — กระดาษ = physical artifact, รูปดิจิทัล = backup, QR = สะพานเชื่อมสองโลก

## Hardware

| อุปกรณ์ | หน้าที่ | เชื่อมต่อ |
|---|---|---|
| iPad | กล้อง, จอสัมผัส, รันหน้าเว็บ | WiFi → เราเตอร์ TL-MR105 |
| Raspberry Pi 4 (2GB) | เสิร์ฟเว็บ (HTTPS) + dithering + สั่งพิมพ์ + session/transaction state | LAN → เราเตอร์ TL-MR105 (สำรอง: WiFi → iPhone Hotspot) |
| Xprinter XP-C300H | พิมพ์ใบเสร็จ 80mm/203dpi, มี auto-cutter | **USB → Pi โดยตรง** (ไม่ใช้ LAN แม้เครื่องรองรับ เพราะตัดสินใจใช้ USB แล้ว) |
| TP-Link TL-MR105 | เราเตอร์ 4G ศูนย์กลาง (ใช้งานตั้งแต่ 2026-10-11) | ซิม 4G → อินเทอร์เน็ต |

Pi มี LAN 1 ช่องเท่านั้น — เมื่อเราเตอร์จริงมาถึง จะใช้ LAN ต่อ Pi↔Router, และยังคง USB ต่อ Pi↔Printer (ตัดสินใจแล้วไม่ใช้ Ethernet Switch เพิ่ม)

## Software Architecture

ทุกอย่างรันบน Raspberry Pi ตัวเดียว (Node.js + Express) เสิร์ฟหน้าเว็บให้ iPad เอง — **ไม่ใช้ Render/Railway หรือเซิร์ฟเวอร์อินเทอร์เน็ตแยกในเฟสนี้** เพราะไม่มี payment webhook ที่ต้องรับ

โครงสร้างโฟลเดอร์ที่ต้องการ (แยก service ตั้งแต่แรก ไม่ยัดรวมในไฟล์เดียว):
```
/src
  server.js          ← แค่ประกอบระบบ ไม่ใส่ logic ตรงนี้
  /services
    printer.js       ← PrinterService: checkReady(), print(), retry(), getStatus(), cut()
    photo.js         ← dithering (Floyd-Steinberg ผ่านไลบรารี sharp)
    storage.js        ← Firebase upload + สร้าง QR
    session.js        ← state machine ต่อ transaction
  /routes
    photo.js
    printer.js
  /db
    database.js       ← SQLite
  /utils
    logger.js
    qr.js
```

เหตุผลที่แยก service: กันวันหลังเปลี่ยนเครื่องพิมพ์/ผู้ให้บริการต่างๆ โดยไม่ต้องรื้อทั้งระบบ — เช่นอย่าเขียน `printer.printImage()` กระจายทั่วโค้ด ให้เรียกผ่าน `PrinterService` เท่านั้น

## Frontend (iPad) — ไฟล์ที่มีอยู่แล้ว

`index.html`, `style.css`, `app.js` — เขียนด้วย HTML/CSS/JS ธรรมดา, ธีมสีไม้-ครีมอบอุ่น (เพราะจะอยู่ในตู้ไม้จริง) มีอยู่แล้ว 5 หน้าจอ: start (drag-to-open) → quantity-screen → frame-screen → camera-screen → preview-screen → printing-screen

**Pi ต้องเสิร์ฟไฟล์พวกนี้เองผ่าน HTTPS** (ไม่ใช่ HTTP ธรรมดา) — เหตุผล: `getUserMedia()` (ขอกล้อง) ทำงานได้เฉพาะใน secure context (HTTPS/localhost) เท่านั้น ต้องใช้ `mkcert` สร้าง certificate ให้ IP ของ Pi แล้วติดตั้ง root cert ลง iPad (Settings → VPN & Device Management → ติดตั้ง Profile → Certificate Trust Settings → Full Trust) ทำครั้งเดียวต่อ iPad 1 เครื่อง

## User Flow (เฟสไม่มีจ่ายเงิน)

```
หน้ารอ → ลากขึ้นเพื่อเริ่ม
→ เลือกจำนวนใบพิมพ์ (1/2/3/4 ใบ — ตอนนี้ราคาไม่มีผลอะไร เพราะฟรี แต่ยังโชว์ตัวเลือกไว้เหมือนเดิม)
→ เลือกกรอบรูป (3 ลาย)
→ [ข้ามขั้นตอนจ่ายเงินไปเลย]
→ นับถอยหลัง 3-2-1 → ถ่าย 1 รูป
→ พรีวิว: ถ่ายใหม่ หรือ ใช้รูปนี้
→ กด "ใช้รูปนี้" → รวมรูปกับกรอบที่เลือกบน Canvas → แปลงขาวดำ (dithering) → พิมพ์ซ้ำตามจำนวนที่เลือก (ผ่าน Pi/USB) + อัพรูปสีขึ้น Firebase สร้าง QR พร้อมกัน
→ โชว์ QR โหลดรูป → กลับหน้ารอ
```

## จุดเทคนิคที่ต้องระวัง (เรียนรู้มาจากการวางแผน อย่าพลาดซ้ำ)

1. **HTTPS ต้องมาก่อนเรื่องอื่น** — milestone แรกที่ควรทดสอบให้ผ่านคือ "เปิดหน้าเว็บจาก Pi บน iPad แล้วเห็นภาพจากกล้องจริง" ก่อนไปทำเรื่อง printer/Firebase เลย เพราะถ้าฐานนี้ไม่ผ่านจะรู้ปัญหาเร็ว
2. **USB printer บน Linux (Pi) ต้องตั้ง udev rules** ปลดล็อกสิทธิ์ให้ Node.js เข้าถึง USB port ได้ก่อนถึงจะสั่งพิมพ์ได้ (ไม่ใช่เสียบแล้วใช้ได้เลยแบบ Windows) เช็คด้วยคำสั่ง `lsusb` ว่า Pi เห็นเครื่องพิมพ์ก่อน
3. **การพิมพ์ต้องแปลงเป็นขาวดำก่อนเสมอ (dithering)** ใช้ Floyd-Steinberg algorithm ผ่านไลบรารี `sharp` — เครื่องพิมพ์ความร้อนไม่มีเฉดสีเทา ถ้าทำ threshold ธรรมดาภาพจะเป็นปื้นดำ-ขาวไม่สวย ควรทำ test chart (หน้าคน, ผมสีเข้ม, เสื้อผ้าสีเข้ม, พื้นหลังขาว, ตัวหนังสือเล็ก, QR) เปรียบเทียบก่อนใช้จริง
4. **เช็คสถานะเครื่องพิมพ์แบบ real** อย่าสมมติว่าซอฟต์แวร์ตรวจกระดาษหมด/ฝาเปิดได้แม่นยำ 100% เสมอ ต้องทดสอบกับเครื่องจริงที่ซื้อมา (paper-out detection, cover detection อาจต่างกันตามรุ่นย่อย)
5. **State ต้องเก็บใน SQLite ไม่ใช่แค่ memory** แม้ยังไม่มี payment ก็ควรมี เพราะยังมี state ของการพิมพ์ที่ค้างได้ (เช่น ไฟดับระหว่างพิมพ์) — เก็บอย่างน้อย: session_id, quantity, frame, photo status, print status, upload status, timestamp
6. **ทุก state ควรมี timeout ของตัวเอง** ไม่ใช่ timer เดียวคุมทั้งระบบ (เช่น countdown 10 วิ, preview 60 วิ, upload 30 วิ แยกกัน) กันเคส state ค้างไม่ sync กัน
7. **Firebase URL ห้ามเดาง่าย** ใช้ random UUID + ควรทำ signed URL อายุสั้น ไม่ใช่ path ตรงๆ แบบ `/photos/123.jpg` และตั้ง retention ลบรูปอัตโนมัติ (เช่น 7-30 วัน) — เรื่อง privacy ของรูปลูกค้าสำคัญมาก
8. **ห้ามใช้ LINE Notify** — ปิดบริการไปแล้วตั้งแต่ 31 มีนาคม 2025 ถ้าจะแจ้งเตือน (กระดาษหมด, error) ต้องใช้ **LINE Messaging API** แทน ผ่าน `NotificationService` abstraction
9. **ลบไฟล์รูปใน Pi หลังพิมพ์+อัพ Firebase สำเร็จ** อย่าเก็บสะสมถาวรใน SD Card เพื่อไม่ให้พื้นที่เต็มในระยะยาว (SD 32GB พอสบายถ้าลบตามนี้)
10. **เซิร์ฟเวอร์รันภายใต้ PM2 (ตั้งเมื่อ 2026-10-03)** ชื่อ process คือ `photobooth` — PM2 ติดตั้งไว้ที่ `~/.local/bin/pm2` (ไม่ได้ลงแบบ global ด้วย sudo) เซิร์ฟเวอร์จึงรันต่อแม้ปิด VS Code/ปิดคอม **ห้ามสั่ง `npm start` ซ้อน** เพราะพอร์ตจะชนกัน หลังแก้โค้ดฝั่งเซิร์ฟเวอร์ให้ใช้ `pm2 restart photobooth` ดู log ด้วย `pm2 logs photobooth` ดูสถานะด้วย `pm2 status` **การเริ่มเองตอน Pi บูต ตั้งแล้ว (2026-10-03) ผ่าน crontab ของ user `tonnam`** (ไม่ใช้ sudo/systemd): บรรทัด `@reboot pm2 resurrect` จะเรียก process ที่ `pm2 save` ไว้ขึ้นมาใหม่ ดูด้วย `crontab -l` log อยู่ที่ `~/.pm2/boot-resurrect.log` — ถ้าเพิ่ม/เปลี่ยน process ใน PM2 ต้องสั่ง `pm2 save` ด้วย ไม่งั้นตอนบูตจะได้รายการเก่า (`systemctl is-enabled pm2-tonnam` จะขึ้น not-found เป็นเรื่องปกติ เพราะไม่ได้ใช้วิธีนั้น)
11. **iPad status bar (เวลา/แบต) — หาทางแก้ได้แล้ว (2026-10-03):** Safari "Add to Home Screen", Guided Access, ไฟล์ `manifest.json` และ Fullscreen API ของเว็บ **ซ่อน status bar ไม่ได้ทั้งหมด** (ทดสอบกับ iPad จริงแล้ว เป็นข้อจำกัดของ iOS) ทางที่ได้ผลคือเปิดตู้ผ่านแอป **"Kiosker: Fullscreen Web Kiosk"** (Top North AB) ตั้ง URL เป็น `https://photobooth-pi.local:3443` — ทดสอบแล้ว: status bar หาย หน้าตู้ทำงานได้ถึงหน้า QR แต่รุ่นฟรีมีป้ายลายน้ำ KIOSKER.IO ที่ขอบล่าง ต้องเป็น Premium ถึงจะหาย **เจ้าของสมัคร Premium แล้ว (บอกเมื่อ 2026-10-10 ก่อนเอาตู้ไปใช้จริงวันที่ 2026-10-11)** Root cert ของ mkcert ติดตั้งและ trust บน iPad เครื่องนี้แล้ว (ทำครั้งเดียว ไม่ต้องทำใหม่ตอนเปลี่ยนเราเตอร์ ถ้ายังเข้าด้วยชื่อ `photobooth-pi.local`) ตั้งค่าใน Kiosker ที่ใช้: Appearance → ปิด Show status bar / Show navigation / Show progress bar, เปิด Disable auto-lock; Menu → เปิด Hide menu automatically (อย่าปิด Show settings button จนกว่าจะรู้วิธีกลับเข้าหน้าตั้งค่า) ตอนติดตั้งเลือก "Opt-out and disable cloud functions"

## Dev Workflow

- เขียน/แก้โค้ดผ่าน VS Code บน Mac ด้วย **Remote-SSH extension** เชื่อมเข้า Pi โดยตรง (แก้ไฟล์ที่อยู่ใน Pi ได้เลย ไม่ต้อง copy/upload แยก)
- Hostname ของ Pi ตอนนี้: ตรวจสอบจาก Raspberry Pi Imager ที่ตั้งไว้ (เช่น `photobooth-pi.local`)
- Network เป็น iPhone Hotspot ชั่วคราว — SSID/password จะเปลี่ยนเมื่อเปลี่ยนไปใช้เราเตอร์จริง ต้องดีไซน์โค้ดไม่ให้ผูกติดกับเครือข่ายใดเครือข่ายหนึ่ง

## สิ่งที่ตัดออกจาก scope นี้ชั่วคราว (อย่าทำจนกว่าจะบอก)

- Payment Gateway / SlipOK / QR จ่ายเงิน / Polling เช็คสถานะจ่ายเงิน
- Render.com หรือเซิร์ฟเวอร์อินเทอร์เน็ตแยก (ไม่จำเป็นเพราะไม่มี webhook ต้องรับ)
- Admin Mode แบบเต็ม (PIN, dashboard ยอดขาย) — เก็บไว้เป็น Phase หลัง
- UPS, temperature sensor, physical button — เก็บไว้พิจารณาหลังพิสูจน์ตลาดแล้ว
