# POS Thermal Printing System
## Final Product & Technical Architecture Specification

**Production POS URL:** `https://payment-printer.vercel.app/`

**Target Printer:** `DNT-585-LU5325`

**Primary Goal:** One online POS system that can be opened from any laptop or mobile device, while printing to the locally available thermal printer through USB or Bluetooth.

---

# 1. Executive Summary

The POS system will be hosted centrally on Vercel.

Users do **not** need the project source code, Node.js, npm, VS Code, or the GitHub repository on every laptop.

Every supported laptop can simply open:

```text
https://payment-printer.vercel.app/
```

The printing method is selected according to the device:

```text
Android Phone
    ↓
Bluetooth
    ↓
Thermal Printer
```

or:

```text
Windows Laptop/Desktop
    ↓
USB / Bluetooth
    ↓
Thermal Printer
```

The POS website remains the same on every device.

---

# 2. Core Requirement

The system must provide:

- One online POS URL
- Same POS UI on every device
- Mobile Bluetooth printing
- Laptop USB printing
- Laptop Bluetooth printing
- Printer selection
- Printer pairing/setup
- Test print
- Receipt templates
- Receipt preview
- ESC/POS thermal printing
- Multiple printers
- Multiple devices
- Printer status
- Print history
- Print retry/error handling
- Future support for additional thermal printers

---

# 3. Target User Experience

The user should experience the system as:

```text
Open POS
    ↓
Create Receipt
    ↓
Print
    ↓
Select / use saved printer
    ↓
Receipt Printed
```

The user should **not** need to understand:

- Next.js
- Node.js
- npm
- GitHub
- Vercel deployment
- ESC/POS
- Bluetooth protocols
- USB protocols

These are implementation details.

---

# 4. Production URL

All laptops and supported mobile devices use the same URL:

```text
https://payment-printer.vercel.app/
```

Example:

```text
Laptop 1
→ https://payment-printer.vercel.app/

Laptop 2
→ https://payment-printer.vercel.app/

Laptop 3
→ https://payment-printer.vercel.app/

Phone
→ https://payment-printer.vercel.app/
```

No separate POS website is required for each device.

---

# 5. Target Printer

The current printer is:

```text
Model:
DNT-585-LU5325

Interfaces:
USB
Bluetooth

Bluetooth Name:
BlueTooth Printer

Bluetooth PIN:
1234

Bluetooth MAC:
DC:0D:30:59:51:A9

Print Speed:
90mm/s (Max)
```

The printer self-test also indicates barcode and multiple code-page capabilities.

The exact Bluetooth profile must be tested before finalizing direct browser Bluetooth support. If it is Bluetooth Classic/SPP, native Android or a Windows connector is the appropriate implementation.

---

# 6. Final Architecture

```text
                         INTERNET
                            │
                            ▼
                ┌───────────────────────┐
                │        VERCEL         │
                │      Next.js POS      │
                │                       │
                │ Dashboard             │
                │ Sales                 │
                │ Receipts              │
                │ Templates             │
                │ Printer Settings      │
                └───────────┬───────────┘
                            │
                         Supabase
                            │
                   Data / Settings /
                     Print Jobs
                            │
             ┌──────────────┴──────────────┐
             │                             │
             ▼                             ▼
       ANDROID DEVICE                 WINDOWS DEVICE
             │                             │
     Native Printer Layer           Printer Connector
             │                             │
        Bluetooth / USB              USB / Bluetooth
             │                             │
             └──────────────┬──────────────┘
                            ▼
                    THERMAL PRINTER
                            │
                            ▼
                         RECEIPT
```

---

# 7. Important Architecture Rule

Vercel hosts the application but does **not** directly access the physical USB or Bluetooth hardware of the user's device.

Therefore:

```text
Vercel
   ↓
POS application
```

and:

```text
Local device
   ↓
Printer hardware
```

must be treated as separate layers.

---

# 8. Mobile Architecture

## Android

Recommended:

```text
Android POS App
      │
      ├── Next.js POS UI
      │
      └── Native Printer Bridge
                │
        Bluetooth / USB
                │
                ▼
         Thermal Printer
```

The native layer handles hardware access.

The web layer handles the POS.

---

# 9. Mobile Bluetooth Flow

First-time setup:

```text
POS
 ↓
Settings
 ↓
Printers
 ↓
Add Printer
 ↓
Bluetooth
 ↓
Scan
 ↓
BlueTooth Printer
 ↓
Pair
 ↓
Connect
 ↓
Test Print
 ↓
Save
```

After setup:

```text
Create Receipt
 ↓
Print
 ↓
Saved Bluetooth Printer
 ↓
Receipt
```

---

# 10. Mobile USB Flow

If the Android device supports USB OTG:

```text
Android Phone
      ↓
USB OTG
      ↓
USB Cable
      ↓
Thermal Printer
```

This can be supported as a secondary connection method.

Bluetooth remains the preferred mobile experience where supported.

---

# 11. Windows Laptop/Desktop Architecture

Every Windows computer opens:

```text
https://payment-printer.vercel.app/
```

The user does **not** need:

```text
GitHub repository
Node.js
npm
VS Code
Next.js source
```

For reliable direct thermal printing, use a lightweight packaged printer connector.

Example:

```text
POS Printer Connector.exe
```

The connector runs in the background.

---

# 12. Windows USB Flow

```text
Browser
   ↓
POS
   ↓
Printer Connector
   ↓
USB
   ↓
Thermal Printer
```

Setup:

```text
Open POS
 ↓
Printer Settings
 ↓
Add Printer
 ↓
USB
 ↓
Detect Printer
 ↓
Test Print
 ↓
Save
```

---

# 13. Windows Bluetooth Flow

```text
Windows
   ↓
Bluetooth Pairing
   ↓
BlueTooth Printer
   ↓
Printer Connector
   ↓
ESC/POS
   ↓
Thermal Printer
```

If Windows exposes the printer through a usable serial/COM interface, the connector can communicate with it through the appropriate serial/Bluetooth layer.

The exact behavior should be validated on the target Windows machine.

---

# 14. Why a Printer Connector Is Needed on Windows

A normal website cannot universally access arbitrary local USB and Bluetooth thermal-printer interfaces.

Therefore:

```text
Browser
   ↓
Local Printer Connector
   ↓
USB / Bluetooth
   ↓
Printer
```

is more reliable than expecting the browser itself to handle every printer.

The connector should be packaged as a normal Windows application.

The user should never need to run:

```bash
npm run agent
```

in production.

---

# 15. Development vs Production

## Development

The existing project can use:

```bash
npm run dev
```

for Next.js.

And:

```bash
npm run agent
```

for the local printer agent during development.

## Production

The website:

```text
https://payment-printer.vercel.app/
```

runs on Vercel.

Windows users run:

```text
POS Printer Connector.exe
```

as a background application.

Android users use the Android printer bridge/application.

---

# 16. One Common POS Interface

The same UI should exist everywhere:

```text
POS
├── Dashboard
├── New Sale
├── Receipts
├── Receipt Templates
├── Printer Settings
└── Print History
```

The user should not see completely different POS software for phone and laptop.

Only the printer connection layer changes.

---

# 17. Printer Abstraction Layer

Create one common printer interface:

```text
PrinterService
```

Possible implementations:

```text
AndroidBluetoothPrinter
AndroidUSBPrinter
WindowsUSBPrinter
WindowsBluetoothPrinter
BrowserPrinter
```

Architecture:

```text
Receipt Data
      ↓
Receipt Renderer
      ↓
ESC/POS Command Builder
      ↓
PrinterService
      ↓
Device-specific connection
      ↓
Printer
```

This prevents duplicate receipt logic.

---

# 18. Receipt Engine

Receipt information should be structured.

Example:

```text
Receipt
├── Receipt Number
├── Date
├── Store Information
├── Customer Information
├── Items
├── Quantity
├── Rate
├── Discount
├── Tax
├── Subtotal
├── Total
├── Payment Method
├── QR Code
├── Barcode
└── Footer
```

The same receipt data should produce:

```text
Web Preview
```

and:

```text
ESC/POS Print Output
```

---

# 19. ESC/POS Layer

The print engine should support:

- Initialize printer
- Text
- Bold
- Alignment
- Font size
- Line spacing
- Separators
- Item tables
- Barcode
- QR code
- Images/logo
- Paper feed
- Cut command where supported
- Code page/encoding
- Printer-specific settings

Example:

```text
Initialize
 ↓
Center
 ↓
Store Name
 ↓
Left
 ↓
Receipt Details
 ↓
Item Table
 ↓
Totals
 ↓
QR
 ↓
Footer
 ↓
Feed
 ↓
Cut
```

---

# 20. Receipt Template System

Receipt data and receipt design should be separated.

```text
Receipt Data
      +
Receipt Template
      ↓
Final Receipt
```

Example templates:

```text
Template A
Template B
Template C
Custom Template
```

The same receipt can be printed with different designs.

---

# 21. Template Designer

Recommended editor:

```text
Receipt Designer

[ Add Text ]
[ Add Image ]
[ Add Line ]
[ Add Item Table ]
[ Add Total ]
[ Add QR ]
[ Add Barcode ]
[ Add Footer ]
```

Live preview:

```text
┌──────────────────────────┐
│       STORE NAME         │
│                          │
│ Receipt #000123          │
│ Date: 15/09/2026         │
│                          │
│ Item        Qty    Price │
│ Product A    2     200   │
│ Product B    1     100   │
│                          │
│ Total              300   │
│                          │
│       Thank You          │
└──────────────────────────┘
```

---

# 22. Printer Settings

Recommended screen:

```text
Printer Settings

Connected Printer
[ BlueTooth Printer ]

Connection
[ Bluetooth ]

Paper Width
[ 58mm ]

Printer Profile
[ DNT-585-LU5325 ]

Encoding
[ Selected Code Page ]

Auto Reconnect
[ ON ]

[ Test Print ]

[ Save Printer ]
```

---

# 23. Add Printer

```text
Add Printer

Choose Connection

[ Bluetooth ]
[ USB ]
[ Network ]
[ Other ]
```

The available options should depend on the device.

### Android

```text
Bluetooth
USB
```

### Windows

```text
USB
Bluetooth
```

---

# 24. Printer Status

Possible states:

```text
● Online
● Connecting
● Offline
● Error
```

Example:

```text
Billing Printer
USB
● Online
```

or:

```text
Bluetooth Printer
Bluetooth
● Offline
```

---

# 25. Multiple Printers

The system should support multiple printers.

Example:

```text
Billing Printer
USB

Reception Printer
Bluetooth

Kitchen Printer
USB

Backup Printer
Bluetooth
```

Each printer gets a unique internal ID.

---

# 26. Default Printer

Each device can have its own default printer.

Example:

```text
Samsung Phone
Default:
Billing Bluetooth Printer
```

Laptop:

```text
Billing Laptop
Default:
Billing USB Printer
```

Therefore the same POS can automatically use the correct printer for each device.

---

# 27. Multiple Devices

Example:

```text
Phone
 ↓ Bluetooth
Printer A

Laptop 1
 ↓ USB
Printer B

Laptop 2
 ↓ Bluetooth
Printer C
```

All devices use:

```text
https://payment-printer.vercel.app/
```

---

# 28. Print Queue

Every print operation should have a print-job status.

```text
Receipt
 ↓
Print Job
 ↓
QUEUED
 ↓
PRINTING
 ↓
PRINTED
```

Possible statuses:

```text
QUEUED
CONNECTING
PRINTING
PRINTED
FAILED
RETRYING
CANCELLED
```

---

# 29. Failed Print Handling

Example:

```text
Print Failed

Reason:
Printer disconnected

[ Retry ]

[ Change Printer ]

[ Cancel ]
```

The system should avoid losing a receipt because the printer temporarily disconnected.

---

# 30. Print History

Recommended:

```text
Print History

Receipt       Printer          Status
------------------------------------------------
#000125       Billing USB      Printed
#000124       Bluetooth        Printed
#000123       Bluetooth        Failed
#000122       Billing USB      Printed
```

Each print job should store:

```text
receipt_id
printer_id
device_id
status
attempts
error
created_at
printed_at
```

---

# 31. Supabase

Recommended tables:

```text
users
devices
printers
printer_profiles
receipts
receipt_templates
print_jobs
print_logs
```

### Printers

```text
id
name
model
connection_type
device_identifier
paper_width
status
last_seen
created_at
```

### Devices

```text
id
name
platform
device_identifier
default_printer_id
last_seen
```

### Print Jobs

```text
id
receipt_id
printer_id
device_id
status
attempts
error
created_at
printed_at
```

---

# 32. Offline Support

A future version can support offline POS operation.

```text
POS
 ↓
Local Storage / IndexedDB
 ↓
Receipt Created
 ↓
Local Print Queue
 ↓
Bluetooth / USB Printer
```

When internet returns:

```text
Internet
 ↓
Supabase Sync
```

This is especially useful for POS environments with unreliable internet.

---

# 33. Security

The printer connector must not expose an unrestricted local interface.

Recommended:

- Authenticated device registration
- Printer allow-list
- Secure local communication
- HTTPS
- Short-lived authentication tokens
- User/device authorization
- Print-job validation
- No arbitrary command execution
- No arbitrary file execution
- No public printer ports

---

# 34. Browser Web Bluetooth

Web Bluetooth can be considered as an optional capability.

Architecture:

```text
Browser
 ↓
Web Bluetooth
 ↓
BLE/GATT Printer
```

However, this must not be assumed to work with the current printer.

If the printer uses Bluetooth Classic/SPP:

```text
Web Bluetooth
     ✕
Bluetooth Classic
```

In that case use:

```text
Android Native Bluetooth
```

or:

```text
Windows Printer Connector
```

This is why the final system should not depend entirely on browser Bluetooth.

---

# 35. iPhone / iPad

iOS has different browser and Bluetooth restrictions.

Direct Bluetooth thermal printing from a normal website should not be treated as guaranteed.

If iPhone/iPad support is required, create a dedicated native iOS printing layer or use a compatible printer/vendor SDK.

The initial priority can remain:

```text
Android
Windows
```

---

# 36. Network Printing — Future

If a future printer supports Wi-Fi/Ethernet:

```text
Phone/Laptop
      ↓
Wi-Fi / LAN
      ↓
Network Printer
```

The architecture can later add:

```text
NetworkPrinter
```

without changing the receipt engine.

---

# 37. Printer Profiles

Do not hard-code only one printer model.

Create profiles:

```text
DNT-585-LU5325
```

and future:

```text
Epson
XPrinter
Rongta
TVS
Other ESC/POS
```

Profile data:

```text
model
paper_width
encoding
code_page
line_width
print_density
supports_cut
supports_qr
supports_barcode
connection_types
```

---

# 38. Device-Specific Behavior

The system should detect the platform.

Example:

```text
Android
 ↓
Show:
Bluetooth
USB
```

```text
Windows
 ↓
Show:
USB
Bluetooth
```

```text
Unsupported Browser
 ↓
Show:
Supported printing options
```

The receipt interface remains the same.

---

# 39. Final User Flow — Laptop

### First time

```text
Open Chrome
      ↓
https://payment-printer.vercel.app/
      ↓
Printer Settings
      ↓
Install POS Printer Connector
      ↓
Add Printer
      ↓
USB / Bluetooth
      ↓
Test Print
      ↓
Save
```

### Every time after setup

```text
Open website
      ↓
Create Receipt
      ↓
Print
      ↓
Receipt Printed
```

No code installation.

No repository.

No terminal.

No VS Code.

---

# 40. Final User Flow — Mobile

### First time

```text
Open POS
      ↓
Printer Settings
      ↓
Add Bluetooth Printer
      ↓
Scan
      ↓
BlueTooth Printer
      ↓
Pair
      ↓
Connect
      ↓
Test Print
      ↓
Save
```

### Every time after setup

```text
Create Receipt
      ↓
Print
      ↓
Bluetooth Printer
      ↓
Receipt Printed
```

---

# 41. Final Product Structure

```text
POS Thermal
│
├── Next.js Web POS
│   ├── Dashboard
│   ├── Sales
│   ├── Receipts
│   ├── Templates
│   ├── Printer Settings
│   └── Print History
│
├── Shared Receipt Engine
│   ├── Receipt Data
│   ├── ESC/POS Renderer
│   ├── Barcode
│   ├── QR
│   └── Formatting
│
├── Android
│   └── Native Printer Bridge
│       ├── Bluetooth
│       └── USB
│
└── Windows
    └── POS Printer Connector
        ├── USB
        └── Bluetooth
```

---

# 42. Recommended Technology Stack

## Web

```text
Next.js
React
TypeScript
Tailwind CSS
Vercel
```

## Database

```text
Supabase
PostgreSQL
```

## Windows

```text
Node.js-based printer connector
serial/USB communication
ESC/POS
Packaged Windows executable
```

The existing project already has an `agent` script and a serial-port dependency available in its dependency tree, so the existing agent concept can be evolved into the production Windows connector.

## Android

Recommended direction:

```text
Next.js
+
Capacitor / Android wrapper
+
Native Bluetooth Classic support
+
USB support
```

---

# 43. Development Roadmap

## Phase 1

Complete:

```text
POS
Receipt
Preview
Templates
```

## Phase 2

Build:

```text
Shared ESC/POS Engine
```

## Phase 3

Build:

```text
Windows Printer Connector
```

Support:

```text
USB
Bluetooth
```

## Phase 4

Build:

```text
Android Printer Bridge
```

Support:

```text
Bluetooth
USB OTG
```

## Phase 5

Add:

```text
Printer Management
Multiple Printers
Default Printer
Test Print
```

## Phase 6

Add:

```text
Print Queue
Print History
Retry
Error Handling
```

## Phase 7

Add:

```text
Offline Mode
Local Queue
Cloud Sync
```

## Phase 8

Production:

```text
Vercel
+
Supabase
+
Android POS App
+
Windows Printer Connector
```

---

# 44. Final Architecture

```text
                         ┌─────────────────────┐
                         │       VERCEL        │
                         │      Next.js        │
                         │        POS          │
                         └──────────┬──────────┘
                                    │
                                    │
                              ┌─────▼─────┐
                              │ Supabase  │
                              │ Database  │
                              └─────┬─────┘
                                    │
                     ┌──────────────┴──────────────┐
                     │                             │
                     ▼                             ▼
              ┌───────────────┐             ┌───────────────┐
              │ ANDROID       │             │ WINDOWS       │
              │ POS APP       │             │ CONNECTOR     │
              │               │             │               │
              │ Native BT     │             │ USB           │
              │ Native USB    │             │ Bluetooth     │
              └───────┬───────┘             └───────┬───────┘
                      │                              │
                      │                              │
                      └──────────────┬───────────────┘
                                     ▼
                           ┌──────────────────┐
                           │ DNT-585-LU5325   │
                           │ Thermal Printer  │
                           └────────┬─────────┘
                                    │
                                    ▼
                                  PRINT
```

---

# 45. Final Requirements Checklist

| Requirement | Solution |
|---|---|
| One POS URL | `https://payment-printer.vercel.app/` |
| Vercel hosting | Yes |
| No code on every laptop | Yes |
| No GitHub repo on laptops | Yes |
| No Node/npm for normal users | Yes |
| Android Bluetooth | Native Android layer |
| Android USB | USB OTG/native layer |
| Windows USB | Printer Connector |
| Windows Bluetooth | Printer Connector |
| Same POS UI | Yes |
| Same receipt engine | Yes |
| Receipt templates | Yes |
| ESC/POS | Yes |
| Multiple printers | Yes |
| Multiple devices | Yes |
| Default printer | Yes |
| Test print | Yes |
| Print history | Yes |
| Print queue | Yes |
| Retry failed jobs | Yes |
| Offline support | Future phase |
| Network printer | Future phase |
| iPhone/iPad | Separate native implementation |
| Manual `npm run agent` in production | No |

---

# 46. Final Product Vision

The final user experience should be extremely simple:

```text
                 PAYMENT PRINTER POS

              https://payment-printer.vercel.app/

                         ↓

                   Create Receipt

                         ↓

                       PRINT

                         ↓

        ┌─────────────────────────────────┐
        │ Printer: Billing Printer        │
        │ Connection: Bluetooth           │
        │ Status: ● Connected              │
        └─────────────────────────────────┘

                         ↓

                    RECEIPT PRINTED
```

### Mobile

```text
Phone
  ↓
Bluetooth
  ↓
Printer
```

### Laptop

```text
Laptop
  ↓
USB / Bluetooth
  ↓
Printer
```

### Core principle

```text
ONE WEBSITE
ONE POS
ONE RECEIPT ENGINE
MULTIPLE DEVICE TYPES
MULTIPLE CONNECTION TYPES
MULTIPLE PRINTERS
```

The website remains centralized at:

```text
https://payment-printer.vercel.app/
```

while device-specific printer access is handled by the appropriate Android native layer or Windows printer connector.
