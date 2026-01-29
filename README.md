Lynmark System ver. 1.1  10-15-2025

Project Structure

├── index.html           - Main HTML file - Complete tenant portal
├── script.js            - JavaScript functionality and animations
├── styles.css           - Main stylesheet with modern UI components
├── icons.svg            - SVG icon definitions for buttons and UI
├── lynmark-logo.png     - Main logo (used in loading animation and header)
├── bg.jpg               - Background image
└── README.md            - This documentation file

Key Components

1. Logo Configuration
- Main Header: `index.html` lines 70-72
- File: `lynmark-logo.png` (110px recommended size for optimal display)
2. Main Content Sections
File: `index.html`

Welcome Message (Lines 75-78)
```html
<h1>Welcome</h1>
<p>You have successfully authenticated your device. To de-authenticate a device, click the device logout below.<br />
Install WhatsApp to communicate with admin or access the tenant chat.</p>
```

Navigation Buttons (Lines 83-100)
- Internet Browser → Google
- Internet Upgrade & Info → Internal page
- Tenant Hub → `http://192.168.30.3:8123` (Home Assistant)
- Kitchen Camera → `http://192.168.30.2/lan_site/kitchen_cam/`
- Device Logout → TP-Link portal logout

Social Media Links (Lines 108-119)
- Facebook: `https://www.facebook.com/profile.php?id=61579720108219`
- WhatsApp: `https://chat.whatsapp.com/I6RRzvWa1Kq8t7Ei1stsdO`

3. Internet Tier Cards & Speed Test
Location: `index.html`
- Speed Test Section: lines 155-244
- Tier Cards HTML: lines 247-300

Current Tier Structure:
```
Tier 1 — Free
- 1.5 Mbps Down / 1 Mbps Up
- 2 devices
- Browsing, Social Media, SD @ 480p

Tier 2 — HD Stream (₱200)
- 5 Mbps Down / 3 Mbps Up  
- 3 devices
- HD Streaming, Video Calls, App Downloads

Tier 3 — 1440p / Gaming / Business (N/A)
- 14 Mbps Down / 7.5 Mbps Up
- 4 devices
- Gaming, Business Use, HD Calls

Tier 4 — 4K Streaming (N/A)
- 40 Mbps Down / 15 Mbps Up
- 4 devices
- Gaming Downloads, 4K Streaming, Premium Use
````

To Update Tiers: Modify the HTML structure (lines 247-300) and CSS variables (lines 328-331) for colors.

4. Internet Rules & Guidelines (Line 144)
Current content includes:
- Device logout requirements
- System maintenance schedule (3:00 AM, 1st of month)
- Speed notices and support information
- Fair use policy

5. Wi-Fi Usage Disclaimer (Line 962)
Important legal text about network usage, risk acknowledgment, and access policies.
````
Tier Colors (Embedded CSS lines 328-331)
```css
--t1: #7dd3fc;  Tier 1 - Cyan 
--t2: #22c55e;  Tier 2 - Green 
--t3: #a78bfa;  Tier 3 - Purple 
--t4: #f59e0b;  Tier 4 - Gold 
```

Updating Tier Information
1. Locate tier HTML structure (lines 247-300)
2. Modify speeds, prices, and descriptions
3. Update CSS colors if needed (lines 328-331)


Changing Contact Information
1. Facebook URL: Line 111
2. WhatsApp Group: Line 117
3. Spotify Jam Link: Line 1040

Modifying Service URLs
1. Tenant Hub: Line 92 (`http://192.168.30.3:8123`)
2. Kitchen Camera: Line 95 (`http://192.168.30.2/lan_site/kitchen_cam/`)
3. Device Logout: Line 98 (`http://portal.tplink.net/portal/logout`)
4. Speed Test URLs: `script.js` lines 2965-2968 (Cloudflare & Ookla)


Logo Replacement
1. Replace `lynmark-logo.png` with new logo
2. Ensure dimensions work well at 110px size
3. Test loading animation appearance
4. Logo appears in both loading screen (line 44) and header (line 71)


