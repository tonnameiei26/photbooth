# Receipt Photo Booth — Project Brief

## สถานะปัจจุบัน (สำคัญมาก อ่านก่อนเริ่ม)

- **เฟสนี้ยังไม่มีระบบจ่ายเงิน** ตู้ให้ใช้ฟรีทั้งหมด เพื่อเอาไป promote/ทดสอบให้คนรู้จักก่อน — **ห้ามเขียนโค้ดส่วน Payment/QR จ่ายเงินตอนนี้** flow เริ่มจากเลือกจำนวนใบ/เลือกกรอบ แล้วข้ามไปถ่ายรูปได้เลย (ไม่มีขั้นตอนรอจ่ายเงิน)
- **เครือข่ายตอนนี้ใช้ iPhone Hotspot ชั่วคราว** (ยังไม่มีเราเตอร์ TP-Link TL-MR105 จริง กำลังรอของส่ง) — Raspberry Pi และ iPad ต่อ WiFi จาก iPhone Hotspot เดียวกันอยู่ **อย่า hardcode SSID/IP ของเราเตอร์ในโค้ด** เพราะเครือข่ายจะเปลี่ยนทีหลังตอนของมาถึง ให้ตั้งค่าผ่าน environment variable หรือไฟล์ config แยกแทน
- คนเขียนโค้ด (เจ้าของเครื่อง) เป็นมือใหม่ พื้นฐาน JavaScript/HTML/CSS อธิบายละเอียด ไม่ต้องสมมติว่ารู้ศัพท์เทคนิคมาก่อน

## Concept

ตู้ถ่ายรูปขนาดเล็กสไตล์ "Receipt Photobooth" ในตู้ไม้ดีไซน์สวยงาม ใช้ iPad เป็นกล้อง+จอสัมผัส ถ่าย **รูปเดียวต่อครั้ง** (ไม่ใช่แถบหลายรูป) ลูกค้าเลือกจำนวนใบพิมพ์และลายกรอบก่อนถ่าย พิมพ์ออกมาเป็นใบเสร็จขาวดำ (dithering) พร้อม QR โหลดรูปสีเก็บมือถือ

Positioning: "เครื่องพิมพ์ความทรงจำเป็นใบเสร็จ" ไม่ใช่แค่ photo booth ทั่วไป — กระดาษ = physical artifact, รูปดิจิทัล = backup, QR = สะพานเชื่อมสองโลก

## Hardware

| อุปกรณ์ | หน้าที่ | เชื่อมต่อ |
|---|---|---|
| iPad | กล้อง, จอสัมผัส, รันหน้าเว็บ | WiFi → iPhone Hotspot (ชั่วคราว) |
| Raspberry Pi 4 (2GB) | เสิร์ฟเว็บ (HTTPS) + dithering + สั่งพิมพ์ + session/transaction state | WiFi → iPhone Hotspot (ชั่วคราว) |
| Xprinter XP-C300H | พิมพ์ใบเสร็จ 80mm/203dpi, มี auto-cutter | **USB → Pi โดยตรง** (ไม่ใช้ LAN แม้เครื่องรองรับ เพราะตัดสินใจใช้ USB แล้ว) |
| (ยังไม่มา) TP-Link TL-MR105 | เราเตอร์ศูนย์กลางตอนใช้งานจริง | จะมาแทน iPhone Hotspot ทีหลัง |

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
10. **ตั้ง PM2 ให้รัน server.js อัตโนมัติทุกครั้งที่ Pi บูต** กันไฟดับแล้วต้องไปเสียบจอ/คีย์บอร์ดสั่งรันเอง

## Dev Workflow

- เขียน/แก้โค้ดผ่าน VS Code บน Mac ด้วย **Remote-SSH extension** เชื่อมเข้า Pi โดยตรง (แก้ไฟล์ที่อยู่ใน Pi ได้เลย ไม่ต้อง copy/upload แยก)
- Hostname ของ Pi ตอนนี้: ตรวจสอบจาก Raspberry Pi Imager ที่ตั้งไว้ (เช่น `photobooth-pi.local`)
- Network เป็น iPhone Hotspot ชั่วคราว — SSID/password จะเปลี่ยนเมื่อเปลี่ยนไปใช้เราเตอร์จริง ต้องดีไซน์โค้ดไม่ให้ผูกติดกับเครือข่ายใดเครือข่ายหนึ่ง

## สิ่งที่ตัดออกจาก scope นี้ชั่วคราว (อย่าทำจนกว่าจะบอก)

- Payment Gateway / SlipOK / QR จ่ายเงิน / Polling เช็คสถานะจ่ายเงิน
- Render.com หรือเซิร์ฟเวอร์อินเทอร์เน็ตแยก (ไม่จำเป็นเพราะไม่มี webhook ต้องรับ)
- Admin Mode แบบเต็ม (PIN, dashboard ยอดขาย) — เก็บไว้เป็น Phase หลัง
- UPS, temperature sensor, physical button — เก็บไว้พิจารณาหลังพิสูจน์ตลาดแล้ว
