# Jalsa — proposed coverage exceptions

For approval. Nothing here is in `config/coverage-exceptions.json`; that file is written by a person.

Generated from `npm run coverage -- --app jalsa` against UniqBrio/JalsaRestaurant @ `69b25c548b` (2026-10-23). Paths are under `jalsa/` in that repo. 306 interactive test ids are not exercised by any flow: 7 are NEW (they block the check) and 299 are on the adoption backlog (debt, not blocking).

| group | what it means | count |
|---|---|---|
| A. Never pressed — writes, sends, prints, pays, leaves the app | the handler saves, posts, prints, dials, shares or downloads | 121 |
| B. Form values, cart lines, non-search typing | local state only, but outside what a read-only flow may press | 144 |
| C. Only reachable after a write, or in a state a capture cannot create | listed so you know the screen exists | 39 |
| D. No honest selector | the engine's prefix matching would credit a different control | 2 |

## 1. The 7 NEW ids — these decide whether coverage passes

All seven were added to the app on 22-Oct-2026, after the backlog was taken, so they are not on it. Each prints, changes the print setting, or exists only after a write. Coverage fails until each has an approved exception (or the app changes). Suggested entries, to paste into `apps/jalsa/config/coverage-exceptions.json` **after review**:

```json
{
  "app": "jalsa",
  "exceptions": [
    {
      "testid": "print-ask-invoice",
      "reason": "Appears only after a round is sent or a payment is recorded, and its confirm prints; both are writes.",
      "module": "_global"
    },
    {
      "testid": "print-ask-kot",
      "reason": "Appears only after a round is sent or a payment is recorded, and its confirm prints; both are writes.",
      "module": "_global"
    },
    {
      "testid": "owner-print-invoice-enabled",
      "reason": "Saves the automatic-printing setting for the whole restaurant; real accounts are read-only.",
      "module": "owner"
    },
    {
      "testid": "owner-print-kot-enabled",
      "reason": "Saves the automatic-printing setting for the whole restaurant; real accounts are read-only.",
      "module": "owner"
    },
    {
      "pattern": "owner-print-once-*",
      "reason": "Prints a KOT on the kitchen printer; real accounts are read-only and a capture must not print.",
      "module": "owner"
    },
    {
      "pattern": "staff-kot-print-once-*",
      "reason": "Prints a KOT on the kitchen printer; real accounts are read-only and a capture must not print.",
      "module": "staff"
    },
    {
      "pattern": "staff-print-once-*",
      "reason": "Prints a KOT on the kitchen printer; real accounts are read-only and a capture must not print.",
      "module": "staff"
    }
  ]
}
```

| test id or pattern | file:line | why it must not be pressed | suggested reason |
|---|---|---|---|
| `print-ask-invoice` | src/components/ui/print-ask.tsx:171 | The prompt opens only from the server answer to placing a round or recording a payment with automatic printing off (print-ask.tsx:131); its confirm prints | Appears only after a round is sent or a payment is recorded, and its confirm prints; both are writes. |
| `print-ask-kot` | src/components/ui/print-ask.tsx:171 | The prompt opens only from the server answer to placing a round or recording a payment with automatic printing off (print-ask.tsx:131); its confirm prints | Appears only after a round is sent or a payment is recorded, and its confirm prints; both are writes. |
| `owner-print-invoice-enabled` | src/features/owner/sections/PrintSetupSection.tsx:207 | onCheckedChange calls saveSwitch, which posts write-setting "print" (PrintSetupSection.tsx:180) — changes how every ticket prints | Saves the automatic-printing setting for the whole restaurant; real accounts are read-only. |
| `owner-print-kot-enabled` | src/features/owner/sections/PrintSetupSection.tsx:199 | onCheckedChange calls saveSwitch, which posts write-setting "print" (PrintSetupSection.tsx:180) — changes how every ticket prints | Saves the automatic-printing setting for the whole restaurant; real accounts are read-only. |
| `owner-print-once-*` | src/features/owner/sections/LiveOrders.tsx:509 | printNow() posts print-kot to /api/{owner,staff}/action at once and prints the ticket on the kitchen printer (components/ui/print-ask.tsx:99) | Prints a KOT on the kitchen printer; real accounts are read-only and a capture must not print. |
| `staff-kot-print-once-*` | src/features/staff/StaffLists.tsx:189 | printNow() posts print-kot to /api/{owner,staff}/action at once and prints the ticket on the kitchen printer (components/ui/print-ask.tsx:99) | Prints a KOT on the kitchen printer; real accounts are read-only and a capture must not print. |
| `staff-print-once-*` | src/features/staff/StaffTables.tsx:538 | printNow() posts print-kot to /api/{owner,staff}/action at once and prints the ticket on the kitchen printer (components/ui/print-ask.tsx:99) | Prints a KOT on the kitchen printer; real accounts are read-only and a capture must not print. |

Add `approvedBy` and, if you want them reviewed again, `expires` (an ISO date) to each entry. Checked on 23-Oct-2026: with exactly these seven entries in place, `npm run coverage -- --app jalsa` reports `NEW uncovered 0 · excepted 7` and **VERDICT PASS** (the file was written for that one run and removed; it is not committed).

## 2. Never pressed — writes, sends, prints, pays, leaves the app

Each handler was read before deciding. These are on the backlog already, so they do not block; an exception is only needed if you want them out of the debt list. If you add one, run `npm run coverage -- --app jalsa --shrink-baseline` afterwards (an id that is both on the backlog and excepted fails the check).

| test id or pattern | file:line | why it must not be pressed | suggested reason |
|---|---|---|---|
| `guest-inactive-call-link` | src/features/guest/GuestApp.tsx:470 | A tel: link — dials the restaurant (GuestApp.tsx:470, :507; GuestSheets.tsx:246) | Places a phone call to the restaurant. |
| `guest-closed-call-link` | src/features/guest/GuestApp.tsx:507 | A tel: link — dials the restaurant (GuestApp.tsx:470, :507; GuestSheets.tsx:246) | Places a phone call to the restaurant. |
| `guest-upsell-add-*` | src/features/guest/GuestClosure.tsx:235 | Posts /api/guest/cart then /api/guest/round (GuestClosure.tsx:132) | Adds a dish and sends it to the kitchen as a new round. |
| `guest-upsell-continue-ordering` | src/features/guest/GuestClosure.tsx:277 | Posts /api/guest/bill action resume-ordering (GuestProgress.tsx:316, :326; GuestClosure.tsx:282) | Withdraws the table's payment request; changes the bill status. |
| `guest-tip-*` | src/features/guest/GuestClosure.tsx:386 | Posts /api/guest/bill action tip (GuestClosure.tsx:331) | Sets a tip amount on the real bill. |
| `guest-tip-custom-apply` | src/features/guest/GuestClosure.tsx:435 | Posts /api/guest/bill action tip (GuestClosure.tsx:331) | Sets a tip amount on the real bill. |
| `guest-pay-succeed` | src/features/guest/GuestClosure.tsx:514 | Posts /api/guest/bill action pay with an outcome (GuestClosure.tsx:483) | Reports a payment outcome on the real bill. |
| `guest-pay-fail` | src/features/guest/GuestClosure.tsx:517 | Posts /api/guest/bill action pay with an outcome (GuestClosure.tsx:483) | Reports a payment outcome on the real bill. |
| `guest-loved-add` | src/features/guest/GuestClosure.tsx:620 | Posts /api/guest/ask "Parcel a favourite" (GuestSheets.tsx:377, GuestClosure.tsx:624) | Orders a takeaway parcel of a dish. |
| `guest-whatsapp` | src/features/guest/GuestClosure.tsx:638 | A "share the bill on WhatsApp" action; today it only shows a toast, but the control is a send and would start sending the day the provider is connected (GuestClosure.tsx:640, :741) | A share/send action; never pressed by a capture so it cannot send once wired up. |
| `guest-review-link` | src/features/guest/GuestClosure.tsx:657 | Opens the restaurant's external review page in a new tab (GuestClosure.tsx:657) | Leaves the app for a third-party review site. |
| `guest-remind-captain` | src/features/guest/GuestClosure.tsx:666 | Posts /api/guest/bill action request-payment (GuestProgress.tsx:306, GuestClosure.tsx:671) | Asks the captain for the bill; changes the bill status. |
| `guest-invoice-whatsapp` | src/features/guest/GuestClosure.tsx:739 | A "share the bill on WhatsApp" action; today it only shows a toast, but the control is a send and would start sending the day the provider is connected (GuestClosure.tsx:640, :741) | A share/send action; never pressed by a capture so it cannot send once wired up. |
| `guest-qty-*` | src/features/guest/GuestOrdering.tsx:476 | Posts /api/guest/cart (GuestApp.tsx:182, GuestSheets.tsx:172) — puts a dish in this table's cart | Adds to or changes the table's cart on the real database; guest flows are read-only. |
| `guest-add-*` | src/features/guest/GuestOrdering.tsx:483 | Posts /api/guest/cart (GuestApp.tsx:182, GuestSheets.tsx:172) — puts a dish in this table's cart | Adds to or changes the table's cart on the real database; guest flows are read-only. |
| `guest-cart-qty-*` | src/features/guest/GuestOrdering.tsx:576 | Posts /api/guest/cart (GuestApp.tsx:182, GuestSheets.tsx:172) — puts a dish in this table's cart | Adds to or changes the table's cart on the real database; guest flows are read-only. |
| `guest-send-to-kitchen` | src/features/guest/GuestOrdering.tsx:616 | Posts /api/guest/round — sends a round to the kitchen (GuestOrdering.tsx:525) | Sends a round to the kitchen and opens or extends a bill. |
| `guest-heart-*` | src/features/guest/GuestProgress.tsx:407 | Posts /api/guest/favourite (GuestProgress.tsx:281) | Saves a favourite dish on the party's bill. |
| `guest-continue-ordering` | src/features/guest/GuestProgress.tsx:462 | Posts /api/guest/bill action resume-ordering (GuestProgress.tsx:316, :326; GuestClosure.tsx:282) | Withdraws the table's payment request; changes the bill status. |
| `guest-cancel-payment-request` | src/features/guest/GuestProgress.tsx:469 | Posts /api/guest/bill action resume-ordering (GuestProgress.tsx:316, :326; GuestClosure.tsx:282) | Withdraws the table's payment request; changes the bill status. |
| `guest-request-payment` | src/features/guest/GuestProgress.tsx:487 | Posts /api/guest/bill action request-payment (GuestProgress.tsx:306, GuestClosure.tsx:671) | Asks the captain for the bill; changes the bill status. |
| `guest-queue-leave` | src/features/guest/GuestQueue.tsx:205 | Posts /api/guest/queue action leave (GuestQueue.tsx:210) | Removes a party from the waitlist. |
| `guest-queue-join-send` | src/features/guest/GuestQueue.tsx:299 | Posts /api/guest/queue action join (GuestQueue.tsx:304) | Adds a party to the real waitlist. |
| `guest-ask-*` | src/features/guest/GuestSheets.tsx:105 | Posts /api/guest/ask — the floor is called to the table (GuestSheets.tsx:66) | Sends a request to the floor staff (water, captain, bill); it reaches real people. |
| `guest-sheet-item-add` | src/features/guest/GuestSheets.tsx:167 | Posts /api/guest/cart (GuestApp.tsx:182, GuestSheets.tsx:172) — puts a dish in this table's cart | Adds to or changes the table's cart on the real database; guest flows are read-only. |
| `guest-sheet-call-link` | src/features/guest/GuestSheets.tsx:246 | A tel: link — dials the restaurant (GuestApp.tsx:470, :507; GuestSheets.tsx:246) | Places a phone call to the restaurant. |
| `guest-sheet-occasion-save` | src/features/guest/GuestSheets.tsx:266 | Posts /api/guest/bill action occasion (GuestSheets.tsx:270) | Records an occasion on the bill and alerts the team. |
| `guest-sheet-suggestion-send` | src/features/guest/GuestSheets.tsx:328 | Posts /api/guest/ask with a suggestion (GuestSheets.tsx:332) | Sends a suggestion to the owner's dashboard. |
| `guest-loved-parcel` | src/features/guest/GuestSheets.tsx:373 | Posts /api/guest/ask "Parcel a favourite" (GuestSheets.tsx:377, GuestClosure.tsx:624) | Orders a takeaway parcel of a dish. |
| `guest-crew-*` | src/features/guest/GuestSheets.tsx:417 | Posts /api/guest/ask — the floor is called to the table (GuestSheets.tsx:66) | Sends a request to the floor staff (water, captain, bill); it reaches real people. |
| `guest-heard-not-now` | src/features/guest/HeardPrompt.tsx:69 | Posts /api/guest/heard { dismiss: true } (HeardPrompt.tsx:46) | Records the dismissal on the guest session. |
| `owner-bill-print` | src/features/owner/BillDetailSheet.tsx:101 | printOnPaper() — window.print() (BillDetailSheet.tsx:101, TableStandSheet.tsx:85, StaffPaperwork.tsx:282) | Opens the print dialog; a capture never prints. |
| `owner-bill-reprint` | src/features/owner/BillDetailSheet.tsx:105 | Posts reprint to the bill/kitchen printer (BillDetailSheet.tsx:105, LiveOrders.tsx:528) | Reprints a ticket on a real printer. |
| `owner-bill-share-whatsapp` | src/features/owner/BillDetailSheet.tsx:128 | An anchor to wa.me with the bill text (BillDetailSheet.tsx:128) | Shares a guest's bill over WhatsApp. |
| `owner-close-confirm` | src/features/owner/CloseBillSheet.tsx:132 | Posts close-bill / record payment (CloseBillSheet.tsx:136) | Records a payment and closes a real bill. |
| `owner-signout` | src/features/owner/OwnerConsole.tsx:180 | DELETE /api/staff/session (OwnerConsole.tsx:150) | Ends the owner session every owner flow shares. |
| `owner-printer-preview-test` | src/features/owner/PrinterPreviewSheet.tsx:65 | Posts a test print (PrinterPreviewSheet.tsx:68, PrintSetupSection.tsx:383, PrintersSection.tsx:112) | Sends a test ticket to a real printer. |
| `owner-stand-print` | src/features/owner/TableStandSheet.tsx:85 | printOnPaper() — window.print() (BillDetailSheet.tsx:101, TableStandSheet.tsx:85, StaffPaperwork.tsx:282) | Opens the print dialog; a capture never prints. |
| `owner-request-done-*` | src/features/owner/sections/Dashboard.tsx:209 | Posts complete-request (Dashboard.tsx:214) | Marks a table request done for the whole floor. |
| `owner-clear-table-*` | src/features/owner/sections/Dashboard.tsx:364 | Posts clear-table (Dashboard.tsx:371) | Marks a table cleared for the next party. |
| `owner-free-table-confirm` | src/features/owner/sections/Dashboard.tsx:397 | Posts free-table (Dashboard.tsx:403) | Frees a table on the real floor. |
| `owner-reply-send` | src/features/owner/sections/Dashboard.tsx:497 | Posts reply-suggestion (Dashboard.tsx:502) | Sends the owner's reply to a guest's phone. |
| `owner-new-round-send` | src/features/owner/sections/Dashboard.tsx:745 | Posts add-round / takeaway (Dashboard.tsx:689) | Sends a round or opens a takeaway bill. |
| `owner-new-round-photo` | src/features/owner/sections/Dashboard.tsx:881 | ImagePicker — choosing a file uploads it (upload-image / takeaway-photo) | Uploads a photo to storage. |
| `owner-day-save` | src/features/owner/sections/DaySetupSection.tsx:176 | Posts write-setting day / menu-checked (DaySetupSection.tsx:180, :196) | Saves the day's note or check on the real setup. |
| `owner-day-menu-checked` | src/features/owner/sections/DaySetupSection.tsx:191 | Posts write-setting day / menu-checked (DaySetupSection.tsx:180, :196) | Saves the day's note or check on the real setup. |
| `owner-settle-*` | src/features/owner/sections/LedgersSection.tsx:126 | Posts settle-tips (LedgersSection.tsx:131) | Settles a person's tips — money. |
| `owner-expense-save` | src/features/owner/sections/LedgersSection.tsx:404 | Posts save-expense (LedgersSection.tsx:409) | Records an expense in the books. |
| `owner-takeaway-packaging-save` | src/features/owner/sections/LiveOrders.tsx:252 | Posts the packaging charge (LiveOrders.tsx:256) | Changes the charge on a real takeaway bill. |
| `owner-reprint-*` | src/features/owner/sections/LiveOrders.tsx:521 | Posts reprint to the bill/kitchen printer (BillDetailSheet.tsx:105, LiveOrders.tsx:528) | Reprints a ticket on a real printer. |
| `owner-reopen-*` | src/features/owner/sections/MenuSection.tsx:101 | Posts the dish's availability (MenuSection.tsx:106, :220) | Takes a dish off or puts it back on the live guest menu. |
| `owner-avail-*` | src/features/owner/sections/MenuSection.tsx:215 | Posts the dish's availability (MenuSection.tsx:106, :220) | Takes a dish off or puts it back on the live guest menu. |
| `owner-category-save` | src/features/owner/sections/MenuSection.tsx:331 | Posts the menu change (MenuSection.tsx:336, :446, :760, :814) | Changes the live menu. |
| `owner-item-save` | src/features/owner/sections/MenuSection.tsx:441 | Posts the menu change (MenuSection.tsx:336, :446, :760, :814) | Changes the live menu. |
| `owner-item-image` | src/features/owner/sections/MenuSection.tsx:487 | ImagePicker — choosing a file uploads it (upload-image / takeaway-photo) | Uploads a photo to storage. |
| `owner-sub-menu-top-*` | src/features/owner/sections/MenuSection.tsx:675 | Posts set-category-parent (MenuSection.tsx:629) | Moves a category in the live menu. |
| `owner-food-type-save-*` | src/features/owner/sections/MenuSection.tsx:757 | Posts the menu change (MenuSection.tsx:336, :446, :760, :814) | Changes the live menu. |
| `owner-food-type-add` | src/features/owner/sections/MenuSection.tsx:811 | Posts the menu change (MenuSection.tsx:336, :446, :760, :814) | Changes the live menu. |
| `owner-print-test-*` | src/features/owner/sections/PrintSetupSection.tsx:491 | Posts a test print (PrinterPreviewSheet.tsx:68, PrintSetupSection.tsx:383, PrintersSection.tsx:112) | Sends a test ticket to a real printer. |
| `owner-print-save` | src/features/owner/sections/PrintSetupSection.tsx:592 | Posts the printer / mapping / template (PrintSetupSection.tsx:400, :1220; PrintersSection.tsx:684) | Changes the real print setup. |
| `owner-bridge-revoke-*` | src/features/owner/sections/PrintSetupSection.tsx:813 | Posts revoke / issue a bridge key (PrintSetupSection.tsx:760, :773) | Issues or revokes a printing computer's key. |
| `owner-bridge-issue` | src/features/owner/sections/PrintSetupSection.tsx:840 | Posts revoke / issue a bridge key (PrintSetupSection.tsx:760, :773) | Issues or revokes a printing computer's key. |
| `owner-print-save-template` | src/features/owner/sections/PrintSetupSection.tsx:1216 | Posts the printer / mapping / template (PrintSetupSection.tsx:400, :1220; PrintersSection.tsx:684) | Changes the real print setup. |
| `owner-print-split` | src/features/owner/sections/PrintSetupSection.tsx:1410 | onCheckedChange posts the split setting (PrintSetupSection.tsx:1399) | Changes how kitchen tickets are split. |
| `owner-print-retry-*` | src/features/owner/sections/PrintSetupSection.tsx:1514 | Posts retry / redirect of a print job (PrintSetupSection.tsx:1517, :1588) | Re-sends a ticket to a printer. |
| `owner-print-elsewhere-confirm` | src/features/owner/sections/PrintSetupSection.tsx:1583 | Posts retry / redirect of a print job (PrintSetupSection.tsx:1517, :1588) | Re-sends a ticket to a printer. |
| `owner-printers-test-*` | src/features/owner/sections/PrintersSection.tsx:246 | Posts a test print (PrinterPreviewSheet.tsx:68, PrintSetupSection.tsx:383, PrintersSection.tsx:112) | Sends a test ticket to a real printer. |
| `owner-printers-remove-*` | src/features/owner/sections/PrintersSection.tsx:257 | Posts remove-printer-mapping (PrintersSection.tsx:132) | Stops a real printer printing for Jalsa. |
| `owner-printers-stop-*-*` | src/features/owner/sections/PrintersSection.tsx:390 | Posts remove-printer-mapping (PrintersSection.tsx:132) | Stops a real printer printing for Jalsa. |
| `owner-printers-download` | src/features/owner/sections/PrintersSection.tsx:559 | Downloads the 35 MB Windows print-bridge installer | Downloads an installer to the capturing machine. |
| `owner-printers-new-code` | src/features/owner/sections/PrintersSection.tsx:602 | Posts issue-pairing-code (PrintersSection.tsx:526) | Issues a pairing code for a printing computer. |
| `owner-printers-show-code` | src/features/owner/sections/PrintersSection.tsx:622 | Posts issue-pairing-code (PrintersSection.tsx:526) | Issues a pairing code for a printing computer. |
| `owner-printers-save` | src/features/owner/sections/PrintersSection.tsx:720 | Posts the printer / mapping / template (PrintSetupSection.tsx:400, :1220; PrintersSection.tsx:684) | Changes the real print setup. |
| `owner-hours-save` | src/features/owner/sections/SettingsSection.tsx:224 | Posts the settings panel (SettingsSection.tsx) | Saves a restaurant setting on the real database. |
| `owner-identity-logo-picker` | src/features/owner/sections/SettingsSection.tsx:329 | ImagePicker — choosing a file uploads it (upload-image / takeaway-photo) | Uploads a photo to storage. |
| `owner-identity-save` | src/features/owner/sections/SettingsSection.tsx:430 | Posts the settings panel (SettingsSection.tsx) | Saves a restaurant setting on the real database. |
| `owner-tax-save` | src/features/owner/sections/SettingsSection.tsx:509 | Posts the settings panel (SettingsSection.tsx) | Saves a restaurant setting on the real database. |
| `owner-invoice-save` | src/features/owner/sections/SettingsSection.tsx:606 | Posts the settings panel (SettingsSection.tsx) | Saves a restaurant setting on the real database. |
| `owner-entrance-toggle` | src/features/owner/sections/SettingsSection.tsx:682 | Posts write-setting queue open/closed (SettingsSection.tsx:687, WaitlistSection.tsx:86) | Opens or closes the restaurant's queue for every guest. |
| `owner-entrance-qr-print-link` | src/features/owner/sections/SettingsSection.tsx:725 | Opens the printable QR image in a new tab (target=_blank) | Opens a new tab for printing a QR code. |
| `owner-block-table-print-link` | src/features/owner/sections/SettingsSection.tsx:762 | Opens the printable QR image in a new tab (target=_blank) | Opens a new tab for printing a QR code. |
| `owner-table-save` | src/features/owner/sections/SettingsSection.tsx:903 | Posts the settings panel (SettingsSection.tsx) | Saves a restaurant setting on the real database. |
| `owner-qr-open-link` | src/features/owner/sections/SettingsSection.tsx:1011 | Opens the printable QR image in a new tab (target=_blank) | Opens a new tab for printing a QR code. |
| `owner-features-save` | src/features/owner/sections/SettingsSection.tsx:1149 | Posts the settings panel (SettingsSection.tsx) | Saves a restaurant setting on the real database. |
| `owner-welcome-save` | src/features/owner/sections/SettingsSection.tsx:1223 | Posts the settings panel (SettingsSection.tsx) | Saves a restaurant setting on the real database. |
| `owner-copy-save` | src/features/owner/sections/SettingsSection.tsx:1296 | Posts the settings panel (SettingsSection.tsx) | Saves a restaurant setting on the real database. |
| `owner-replies-save` | src/features/owner/sections/SettingsSection.tsx:1443 | Posts the settings panel (SettingsSection.tsx) | Saves a restaurant setting on the real database. |
| `owner-engage-review-open-link` | src/features/owner/sections/SettingsSection.tsx:1540 | Opens the external review page / a WhatsApp share / a QR image in a new tab | Leaves the app (third-party site or share). |
| `owner-engage-review-share-link` | src/features/owner/sections/SettingsSection.tsx:1546 | Opens the external review page / a WhatsApp share / a QR image in a new tab | Leaves the app (third-party site or share). |
| `owner-engage-review-qr-link` | src/features/owner/sections/SettingsSection.tsx:1556 | Opens the external review page / a WhatsApp share / a QR image in a new tab | Leaves the app (third-party site or share). |
| `owner-engage-save` | src/features/owner/sections/SettingsSection.tsx:1599 | Posts the settings panel (SettingsSection.tsx) | Saves a restaurant setting on the real database. |
| `owner-default-station-save` | src/features/owner/sections/SettingsSection.tsx:1658 | Posts the settings panel (SettingsSection.tsx) | Saves a restaurant setting on the real database. |
| `owner-paperwork-save` | src/features/owner/sections/StaffPaperwork.tsx:277 | Posts the employment record (StaffPaperwork.tsx:235) | Saves a person's employment record. |
| `owner-paperwork-print` | src/features/owner/sections/StaffPaperwork.tsx:282 | printOnPaper() — window.print() (BillDetailSheet.tsx:101, TableStandSheet.tsx:85, StaffPaperwork.tsx:282) | Opens the print dialog; a capture never prints. |
| `owner-duty-*` | src/features/owner/sections/StaffSection.tsx:215 | Posts set-duty (StaffSection.tsx:221) | Marks a person in or out for today. |
| `owner-pin-*` | src/features/owner/sections/StaffSection.tsx:247 | Posts reissue-pin (StaffSection.tsx:253) | Issues a new PIN for a real person. |
| `owner-staff-save` | src/features/owner/sections/StaffSection.tsx:318 | Posts the person / permissions (StaffSection.tsx:323, :410) | Changes a person or their permissions. |
| `owner-perms-save` | src/features/owner/sections/StaffSection.tsx:405 | Posts the person / permissions (StaffSection.tsx:323, :410) | Changes a person or their permissions. |
| `owner-queue-toggle` | src/features/owner/sections/WaitlistSection.tsx:80 | Posts write-setting queue open/closed (SettingsSection.tsx:687, WaitlistSection.tsx:86) | Opens or closes the restaurant's queue for every guest. |
| `owner-queue-notify-*` | src/features/owner/sections/WaitlistSection.tsx:174 | Posts notify-waitlist (WaitlistSection.tsx:180) | Tells a waiting party their table is ready. |
| `owner-queue-seat-at-*` | src/features/owner/sections/WaitlistSection.tsx:263 | Posts seat-waitlist (WaitlistSection.tsx:270) | Seats a party at a table. |
| `owner-queue-save` | src/features/owner/sections/WaitlistSection.tsx:308 | Posts add-waitlist (WaitlistSection.tsx:312) | Adds a party to the real waitlist. |
| `staff-choose-pin-skip` | src/features/staff/ChoosePin.tsx:215 | POST /api/staff/pin { skip } — rewrites the session cookie (ChoosePin.tsx:215) | Only on a provisional PIN; changes the session. |
| `staff-choose-pin-signout` | src/features/staff/ChoosePin.tsx:233 | DELETE /api/staff/session (ChoosePin.tsx:233) | Only on a provisional PIN; ends the session. |
| `staff-ready-advance-*` | src/features/staff/StaffLists.tsx:81 | Posts /api/staff/action advance-kot (StaffLists.tsx:86, StaffTables.tsx:521) | Moves a round to picked up or served; changes the kitchen ticket. |
| `staff-kot-reprint-*` | src/features/staff/StaffLists.tsx:200 | Posts /api/staff/action reprint (StaffLists.tsx:206, StaffTables.tsx:555) | Reprints a KOT on the kitchen printer. |
| `staff-request-done-*` | src/features/staff/StaffLists.tsx:278 | Posts complete-request (StaffLists.tsx:283) | Marks a table request done for the whole floor. |
| `staff-signout` | src/features/staff/StaffLists.tsx:360 | DELETE /api/staff/session (StaffApp.tsx:120) | Ends the captain session every staff flow shares. |
| `staff-clear-done-*` | src/features/staff/StaffLists.tsx:428 | Posts clear-table (StaffLists.tsx:433) | Marks a table cleared for the next party. |
| `staff-free-table-confirm` | src/features/staff/StaffTables.tsx:183 | Posts free-table (StaffTables.tsx:189) | Frees a table on the real floor. |
| `staff-waiter-*` | src/features/staff/StaffTables.tsx:357 | Posts assign-waiter (StaffTables.tsx:363) | Assigns a waiter to a real bill. |
| `staff-advance-*` | src/features/staff/StaffTables.tsx:516 | Posts /api/staff/action advance-kot (StaffLists.tsx:86, StaffTables.tsx:521) | Moves a round to picked up or served; changes the kitchen ticket. |
| `staff-reprint-*` | src/features/staff/StaffTables.tsx:549 | Posts /api/staff/action reprint (StaffLists.tsx:206, StaffTables.tsx:555) | Reprints a KOT on the kitchen printer. |
| `staff-qty-save` | src/features/staff/StaffTables.tsx:612 | Posts the quantity change (StaffTables.tsx:617) | Changes an item quantity on a real bill. |
| `staff-close-confirm` | src/features/staff/StaffTables.tsx:723 | Posts record-payment / close-bill (StaffTables.tsx:738) | Records a payment and closes a real bill. |
| `staff-send-round` | src/features/staff/StaffTables.tsx:969 | Posts add-round (StaffTables.tsx:981) | Sends a round to the kitchen. |

## 3. Form values, cart lines and non-search typing

Their handlers only set local state; nothing is saved until a Save, Send or Record button that the flows never press. They were left alone because the task allows opening, filtering, searching and cancelling only. If you widen that rule (for example: "local-only form controls may be pressed, then the form cancelled"), most of these can be covered and need no exception. Phone-number and personal-data fields should stay untouched either way.

| test id or pattern | file:line | why it must not be pressed | suggested reason |
|---|---|---|---|
| `guest-tip-custom-input` | src/features/guest/GuestClosure.tsx:411 | Local state only (a quantity, a chip, or text in a form that is never sent) | Only fills in a form whose submit is a write; nothing is sent until submit. |
| `guest-note` | src/features/guest/GuestOrdering.tsx:596 | Local state only (a quantity, a chip, or text in a form that is never sent) | Only fills in a form whose submit is a write; nothing is sent until submit. |
| `guest-queue-size-*` | src/features/guest/GuestQueue.tsx:290 | Local state only (a quantity, a chip, or text in a form that is never sent) | Only fills in a form whose submit is a write; nothing is sent until submit. |
| `guest-sheet-item*` | src/features/guest/GuestSheets.tsx:203 | Local state only (a quantity, a chip, or text in a form that is never sent) | Only fills in a form whose submit is a write; nothing is sent until submit. |
| `guest-occasion-*` | src/features/guest/GuestSheets.tsx:291 | Local state only (a quantity, a chip, or text in a form that is never sent) | Only fills in a form whose submit is a write; nothing is sent until submit. |
| `guest-occasion-name` | src/features/guest/GuestSheets.tsx:306 | Local state only (a quantity, a chip, or text in a form that is never sent) | Only fills in a form whose submit is a write; nothing is sent until submit. |
| `guest-suggestion-body` | src/features/guest/GuestSheets.tsx:349 | Local state only (a quantity, a chip, or text in a form that is never sent) | Only fills in a form whose submit is a write; nothing is sent until submit. |
| `owner-bill-share-phone` | src/features/owner/BillDetailSheet.tsx:225 | A phone-number field | Takes a phone number; no number is ever typed by a capture. |
| `owner-discount*` | src/features/owner/CloseBillSheet.tsx:258 | Local form values in the close-bill sheet (discount, mode, cash tendered, reference) | Only fills in a form whose submit records a payment. |
| `owner-mode-*` | src/features/owner/CloseBillSheet.tsx:270 | Local form values in the close-bill sheet (discount, mode, cash tendered, reference) | Only fills in a form whose submit records a payment. |
| `owner-close*` | src/features/owner/CloseBillSheet.tsx:284 | Local form values in the close-bill sheet (discount, mode, cash tendered, reference) | Only fills in a form whose submit records a payment. |
| `owner-close-reference` | src/features/owner/CloseBillSheet.tsx:297 | Local form values in the close-bill sheet (discount, mode, cash tendered, reference) | Only fills in a form whose submit records a payment. |
| `owner-canned-*` | src/features/owner/sections/Dashboard.tsx:477 | Fills the reply box (local); the only way on is Send acknowledgement | Only fills in a reply whose submit sends it. |
| `owner-reply-body` | src/features/owner/sections/Dashboard.tsx:493 | Fills the reply box (local); the only way on is Send acknowledgement | Only fills in a reply whose submit sends it. |
| `owner-new-round-less-*` | src/features/owner/sections/Dashboard.tsx:800 | Local cart in the new-round sheet; the only way on is Send | Adds to the round's cart (the task rules exclude cart additions). |
| `owner-new-round-add-*` | src/features/owner/sections/Dashboard.tsx:811 | Local cart in the new-round sheet; the only way on is Send | Adds to the round's cart (the task rules exclude cart additions). |
| `owner-takeaway-packaging` | src/features/owner/sections/Dashboard.tsx:845 | A packaging-charge field (local until saved) | Only fills in a charge whose submit is a write. |
| `owner-day-note` | src/features/owner/sections/DaySetupSection.tsx:171 | The floor note text (local until Save) | Only fills in a note whose submit is a write. |
| `owner-expense-date` | src/features/owner/sections/LedgersSection.tsx:441 | Expense form fields (local until Save) | Only fills in an expense whose submit is a write. |
| `owner-expense-amount` | src/features/owner/sections/LedgersSection.tsx:452 | Expense form fields (local until Save) | Only fills in an expense whose submit is a write. |
| `owner-expense-note` | src/features/owner/sections/LedgersSection.tsx:491 | Expense form fields (local until Save) | Only fills in an expense whose submit is a write. |
| `owner-expense-reason` | src/features/owner/sections/LedgersSection.tsx:506 | Expense form fields (local until Save) | Only fills in an expense whose submit is a write. |
| `owner-takeaway-packaging-input` | src/features/owner/sections/LiveOrders.tsx:274 | A packaging-charge field (local until saved) | Only fills in a charge whose submit is a write. |
| `owner-category-name` | src/features/owner/sections/MenuSection.tsx:360 | Menu form fields (local until Save) | Only fills in a menu form whose submit is a write. |
| `owner-item-name` | src/features/owner/sections/MenuSection.tsx:482 | Menu form fields (local until Save) | Only fills in a menu form whose submit is a write. |
| `owner-item-price` | src/features/owner/sections/MenuSection.tsx:506 | Menu form fields (local until Save) | Only fills in a menu form whose submit is a write. |
| `owner-item-type` | src/features/owner/sections/MenuSection.tsx:549 | Pickers in the dish form; choosing only sets the form value (a new food type is created on the server) | Only fills in a menu form whose submit is a write. |
| `owner-item-printer` | src/features/owner/sections/MenuSection.tsx:569 | Pickers in the dish form; choosing only sets the form value (a new food type is created on the server) | Only fills in a menu form whose submit is a write. |
| `owner-item-description` | src/features/owner/sections/MenuSection.tsx:595 | Menu form fields (local until Save) | Only fills in a menu form whose submit is a write. |
| `owner-food-type-name-*` | src/features/owner/sections/MenuSection.tsx:735 | Menu form fields (local until Save) | Only fills in a menu form whose submit is a write. |
| `owner-food-type-class-*` | src/features/owner/sections/MenuSection.tsx:742 | Menu form fields (local until Save) | Only fills in a menu form whose submit is a write. |
| `owner-food-type-new-name` | src/features/owner/sections/MenuSection.tsx:792 | Menu form fields (local until Save) | Only fills in a menu form whose submit is a write. |
| `owner-food-type-new-class` | src/features/owner/sections/MenuSection.tsx:799 | Menu form fields (local until Save) | Only fills in a menu form whose submit is a write. |
| `owner-print-name` | src/features/owner/sections/PrintSetupSection.tsx:616 | Printer form fields (local until Save) | Only fills in a printer form whose submit is a write. |
| `owner-print*` | src/features/owner/sections/PrintSetupSection.tsx:627 | Printer form fields (local until Save) | Only fills in a printer form whose submit is a write. |
| `owner-print-station` | src/features/owner/sections/PrintSetupSection.tsx:642 | Printer form fields (local until Save) | Only fills in a printer form whose submit is a write. |
| `owner-print-paper` | src/features/owner/sections/PrintSetupSection.tsx:650 | Printer form fields (local until Save) | Only fills in a printer form whose submit is a write. |
| `owner-print-conn` | src/features/owner/sections/PrintSetupSection.tsx:664 | Printer form fields (local until Save) | Only fills in a printer form whose submit is a write. |
| `owner-print-address` | src/features/owner/sections/PrintSetupSection.tsx:684 | Printer form fields (local until Save) | Only fills in a printer form whose submit is a write. |
| `owner-print-port` | src/features/owner/sections/PrintSetupSection.tsx:693 | Printer form fields (local until Save) | Only fills in a printer form whose submit is a write. |
| `owner-print-enabled` | src/features/owner/sections/PrintSetupSection.tsx:705 | Printer form fields (local until Save) | Only fills in a printer form whose submit is a write. |
| `owner-bridge-label` | src/features/owner/sections/PrintSetupSection.tsx:834 | Form fields in the bridge / pairing / printer-mapping forms (local until submitted) | Only fills in a printer form whose submit is a write. |
| `owner-print-width-*` | src/features/owner/sections/PrintSetupSection.tsx:980 | Template editor controls (local until Save template) | Only edits a template whose submit is a write. |
| `owner-print-font-*` | src/features/owner/sections/PrintSetupSection.tsx:991 | Template editor controls (local until Save template) | Only edits a template whose submit is a write. |
| `owner-print-field-*-*` | src/features/owner/sections/PrintSetupSection.tsx:1056 | Template editor controls (local until Save template) | Only edits a template whose submit is a write. |
| `owner-print-up-*` | src/features/owner/sections/PrintSetupSection.tsx:1063 | Template editor controls (local until Save template) | Only edits a template whose submit is a write. |
| `owner-print-down-*` | src/features/owner/sections/PrintSetupSection.tsx:1073 | Template editor controls (local until Save template) | Only edits a template whose submit is a write. |
| `owner-print-layout-*` | src/features/owner/sections/PrintSetupSection.tsx:1101 | Template editor controls (local until Save template) | Only edits a template whose submit is a write. |
| `owner-print-sep-*` | src/features/owner/sections/PrintSetupSection.tsx:1129 | Template editor controls (local until Save template) | Only edits a template whose submit is a write. |
| `owner-print-group` | src/features/owner/sections/PrintSetupSection.tsx:1143 | Template editor controls (local until Save template) | Only edits a template whose submit is a write. |
| `owner-print-hide-empty` | src/features/owner/sections/PrintSetupSection.tsx:1150 | Template editor controls (local until Save template) | Only edits a template whose submit is a write. |
| `owner-print-autofit` | src/features/owner/sections/PrintSetupSection.tsx:1202 | Template editor controls (local until Save template) | Only edits a template whose submit is a write. |
| `owner-print-station-all-confirm` | src/features/owner/sections/PrintSetupSection.tsx:1774 | Opens only after a station is chosen in "Set all dishes to…"; its confirm rewrites every dish | Its confirm re-routes every dish; reaching it needs a picker choice. |
| `owner-printers-label` | src/features/owner/sections/PrintersSection.tsx:616 | Form fields in the bridge / pairing / printer-mapping forms (local until submitted) | Only fills in a printer form whose submit is a write. |
| `owner-printers-name` | src/features/owner/sections/PrintersSection.tsx:763 | Form fields in the bridge / pairing / printer-mapping forms (local until submitted) | Only fills in a printer form whose submit is a write. |
| `owner-printers-station` | src/features/owner/sections/PrintersSection.tsx:772 | Form fields in the bridge / pairing / printer-mapping forms (local until submitted) | Only fills in a printer form whose submit is a write. |
| `owner-printers*` | src/features/owner/sections/PrintersSection.tsx:787 | Form fields in the bridge / pairing / printer-mapping forms (local until submitted) | Only fills in a printer form whose submit is a write. |
| `owner-printers-paper-80` | src/features/owner/sections/PrintersSection.tsx:792 | Form fields in the bridge / pairing / printer-mapping forms (local until submitted) | Only fills in a printer form whose submit is a write. |
| `owner-printers-paper-58` | src/features/owner/sections/PrintersSection.tsx:795 | Form fields in the bridge / pairing / printer-mapping forms (local until submitted) | Only fills in a printer form whose submit is a write. |
| `owner-printers-existing*` | src/features/owner/sections/PrintersSection.tsx:807 | Form fields in the bridge / pairing / printer-mapping forms (local until submitted) | Only fills in a printer form whose submit is a write. |
| `owner-rep-from` | src/features/owner/sections/ReportsSection.tsx:237 | Date inputs of the custom report range — a filter, but typing is limited to search boxes | A date filter; harmless, but outside the "type only into search boxes" rule. |
| `owner-rep-to` | src/features/owner/sections/ReportsSection.tsx:246 | Date inputs of the custom report range — a filter, but typing is limited to search boxes | A date filter; harmless, but outside the "type only into search boxes" rule. |
| `owner-hours-open-*` | src/features/owner/sections/SettingsSection.tsx:169 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-hours-close-*` | src/features/owner/sections/SettingsSection.tsx:179 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-hours-shut-*` | src/features/owner/sections/SettingsSection.tsx:184 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-last-order` | src/features/owner/sections/SettingsSection.tsx:209 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-hours-note` | src/features/owner/sections/SettingsSection.tsx:219 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-legal-name` | src/features/owner/sections/SettingsSection.tsx:351 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-display-name` | src/features/owner/sections/SettingsSection.tsx:359 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-address` | src/features/owner/sections/SettingsSection.tsx:368 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-email` | src/features/owner/sections/SettingsSection.tsx:372 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-phone` | src/features/owner/sections/SettingsSection.tsx:375 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-hr-email` | src/features/owner/sections/SettingsSection.tsx:384 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-fssai` | src/features/owner/sections/SettingsSection.tsx:393 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-pan` | src/features/owner/sections/SettingsSection.tsx:396 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-signatory` | src/features/owner/sections/SettingsSection.tsx:409 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-signatory-role` | src/features/owner/sections/SettingsSection.tsx:417 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-gst-rate` | src/features/owner/sections/SettingsSection.tsx:474 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-gstin` | src/features/owner/sections/SettingsSection.tsx:482 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-gst-inclusive` | src/features/owner/sections/SettingsSection.tsx:492 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-prefix` | src/features/owner/sections/SettingsSection.tsx:560 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-reset` | src/features/owner/sections/SettingsSection.tsx:564 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-rounding` | src/features/owner/sections/SettingsSection.tsx:575 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-show-captain` | src/features/owner/sections/SettingsSection.tsx:589 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-show-kot` | src/features/owner/sections/SettingsSection.tsx:596 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-table-name` | src/features/owner/sections/SettingsSection.tsx:933 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-table-zone` | src/features/owner/sections/SettingsSection.tsx:943 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-table-seats` | src/features/owner/sections/SettingsSection.tsx:961 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-table-active` | src/features/owner/sections/SettingsSection.tsx:970 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-feature-*` | src/features/owner/sections/SettingsSection.tsx:1141 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-welcome-enabled` | src/features/owner/sections/SettingsSection.tsx:1199 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-welcome-item-*` | src/features/owner/sections/SettingsSection.tsx:1216 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-copy-*` | src/features/owner/sections/SettingsSection.tsx:1290 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-replies-heading` | src/features/owner/sections/SettingsSection.tsx:1383 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-reply-remove-*` | src/features/owner/sections/SettingsSection.tsx:1397 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-replies-name` | src/features/owner/sections/SettingsSection.tsx:1415 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-replies-text` | src/features/owner/sections/SettingsSection.tsx:1424 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-replies-add` | src/features/owner/sections/SettingsSection.tsx:1429 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-engage-call` | src/features/owner/sections/SettingsSection.tsx:1508 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-engage-review` | src/features/owner/sections/SettingsSection.tsx:1523 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-engage-photos` | src/features/owner/sections/SettingsSection.tsx:1569 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-engage-provider` | src/features/owner/sections/SettingsSection.tsx:1581 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-engage-when` | src/features/owner/sections/SettingsSection.tsx:1590 | Settings form fields (local until the panel's Save) | Only fills in a settings form whose submit is a write. |
| `owner-hr-code` | src/features/owner/sections/StaffPaperwork.tsx:331 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-designation` | src/features/owner/sections/StaffPaperwork.tsx:340 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-department` | src/features/owner/sections/StaffPaperwork.tsx:349 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-joined` | src/features/owner/sections/StaffPaperwork.tsx:361 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-left` | src/features/owner/sections/StaffPaperwork.tsx:376 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-gender` | src/features/owner/sections/StaffPaperwork.tsx:394 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-type` | src/features/owner/sections/StaffPaperwork.tsx:407 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-salary` | src/features/owner/sections/StaffPaperwork.tsx:422 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-reports` | src/features/owner/sections/StaffPaperwork.tsx:435 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-shift` | src/features/owner/sections/StaffPaperwork.tsx:444 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-address` | src/features/owner/sections/StaffPaperwork.tsx:455 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-pan` | src/features/owner/sections/StaffPaperwork.tsx:468 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-uan` | src/features/owner/sections/StaffPaperwork.tsx:477 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-bank` | src/features/owner/sections/StaffPaperwork.tsx:491 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-date` | src/features/owner/sections/StaffPaperwork.tsx:511 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-probation` | src/features/owner/sections/StaffPaperwork.tsx:525 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-notice` | src/features/owner/sections/StaffPaperwork.tsx:533 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-paydate` | src/features/owner/sections/StaffPaperwork.tsx:546 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-paiddays` | src/features/owner/sections/StaffPaperwork.tsx:555 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-lop` | src/features/owner/sections/StaffPaperwork.tsx:564 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-duties` | src/features/owner/sections/StaffPaperwork.tsx:579 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-qualities` | src/features/owner/sections/StaffPaperwork.tsx:593 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-pay-*` | src/features/owner/sections/StaffPaperwork.tsx:614 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-hr-prepared` | src/features/owner/sections/StaffPaperwork.tsx:633 | Employment record fields (local until Save the record); personal data | Only fills in an employment record whose submit is a write. |
| `owner-staff-name` | src/features/owner/sections/StaffSection.tsx:352 | Person and permission form values (local until Save) | Only fills in a staff or permission form whose submit is a write. |
| `owner-staff-role` | src/features/owner/sections/StaffSection.tsx:361 | Person and permission form values (local until Save) | Only fills in a staff or permission form whose submit is a write. |
| `owner-staff-mobile` | src/features/owner/sections/StaffSection.tsx:377 | Person and permission form values (local until Save) | Only fills in a staff or permission form whose submit is a write. |
| `owner-preset-*` | src/features/owner/sections/StaffSection.tsx:432 | Person and permission form values (local until Save) | Only fills in a staff or permission form whose submit is a write. |
| `owner-preset-clear` | src/features/owner/sections/StaffSection.tsx:437 | Person and permission form values (local until Save) | Only fills in a staff or permission form whose submit is a write. |
| `owner-perm-*` | src/features/owner/sections/StaffSection.tsx:454 | Person and permission form values (local until Save) | Only fills in a staff or permission form whose submit is a write. |
| `owner-queue-size` | src/features/owner/sections/WaitlistSection.tsx:342 | Walk-in form fields (local until Save) | Only fills in a waitlist form whose submit is a write. |
| `owner-queue-source` | src/features/owner/sections/WaitlistSection.tsx:350 | Walk-in form fields (local until Save) | Only fills in a waitlist form whose submit is a write. |
| `owner-queue-pair` | src/features/owner/sections/WaitlistSection.tsx:368 | Walk-in form fields (local until Save) | Only fills in a waitlist form whose submit is a write. |
| `owner-queue-phone` | src/features/owner/sections/WaitlistSection.tsx:379 | A phone-number field | Takes a phone number; no number is ever typed by a capture. |
| `staff-qty-step*` | src/features/staff/StaffTables.tsx:638 | Local form values in the quantity and close-bill sheets (stepper, discount, payment mode, cash tendered, reference) | Only fills in a form whose submit is a write. |
| `staff-discount*` | src/features/staff/StaffTables.tsx:777 | Local form values in the quantity and close-bill sheets (stepper, discount, payment mode, cash tendered, reference) | Only fills in a form whose submit is a write. |
| `staff-mode-*` | src/features/staff/StaffTables.tsx:789 | Local form values in the quantity and close-bill sheets (stepper, discount, payment mode, cash tendered, reference) | Only fills in a form whose submit is a write. |
| `staff-close*` | src/features/staff/StaffTables.tsx:804 | Local form values in the quantity and close-bill sheets (stepper, discount, payment mode, cash tendered, reference) | Only fills in a form whose submit is a write. |
| `staff-reference` | src/features/staff/StaffTables.tsx:813 | Local form values in the quantity and close-bill sheets (stepper, discount, payment mode, cash tendered, reference) | Only fills in a form whose submit is a write. |
| `staff-add-qty-*` | src/features/staff/StaffTables.tsx:941 | Local cart on the handset; the only way on is Send round | Adds to the round's cart (the task rules exclude cart additions). |
| `staff-add-*` | src/features/staff/StaffTables.tsx:946 | Local cart on the handset; the only way on is Send round | Adds to the round's cart (the task rules exclude cart additions). |

## 4. Only reachable after a write, or in a state a capture cannot create

These screens exist, but reaching them read-only is impossible: they follow a cart write, a sent round, a payment, an issued PIN or key, a staff move — or they need an outage, a provisional PIN, or a waiting app update. A dummy account in a separate test tenant (`writes: true`, `auth: dummy`) is the way to capture them; Jalsa has none today (`dataIsolation: none`).

| test id or pattern | file:line | why it must not be pressed | suggested reason |
|---|---|---|---|
| `pwa-update-reload` | src/components/ServiceWorkerRegistrar.tsx:58 | Offered only when a new service worker is waiting | Shown only when a new version of the app is waiting to install. |
| `unreachable-*-reload` | src/components/ui/states.tsx:273 | The outage screen, shown only when the database cannot be reached | Shown only during a database outage. |
| `toast-undo` | src/components/ui/toast.tsx:162 | Toasts appear after an action; the read-only flows raise none (Undo is on removing a cart line) | Shown only after an action that raises a toast; Undo follows a cart write. |
| `toast-dismiss` | src/components/ui/toast.tsx:174 | Toasts appear after an action; the read-only flows raise none (Undo is on removing a cart line) | Shown only after an action that raises a toast; Undo follows a cart write. |
| `theme-toggle-*` | src/theme/ThemeToggle.tsx:29 | ThemeToggle is not rendered anywhere in the app (theme/ThemeToggle.tsx has no caller) | Not reachable: the component is not used on any page. |
| `craving-start` | src/features/guest/CravingGame.tsx:249 | On the "order placed" screen, reached only by sending a round from this phone (GuestProgress.tsx:204, PlacedCraving) | Shown only after this phone sends a round to the kitchen. |
| `craving-skip` | src/features/guest/CravingGame.tsx:252 | On the "order placed" screen, reached only by sending a round from this phone (GuestProgress.tsx:204, PlacedCraving) | Shown only after this phone sends a round to the kitchen. |
| `craving-add-*` | src/features/guest/CravingGame.tsx:303 | On the "order placed" screen, reached only by sending a round from this phone (GuestProgress.tsx:204, PlacedCraving) | Shown only after this phone sends a round to the kitchen. |
| `craving-again` | src/features/guest/CravingGame.tsx:319 | On the "order placed" screen, reached only by sending a round from this phone (GuestProgress.tsx:204, PlacedCraving) | Shown only after this phone sends a round to the kitchen. |
| `craving-close` | src/features/guest/CravingGame.tsx:323 | On the "order placed" screen, reached only by sending a round from this phone (GuestProgress.tsx:204, PlacedCraving) | Shown only after this phone sends a round to the kitchen. |
| `craving-tap-*` | src/features/guest/CravingGame.tsx:359 | On the "order placed" screen, reached only by sending a round from this phone (GuestProgress.tsx:204, PlacedCraving) | Shown only after this phone sends a round to the kitchen. |
| `craving-tap-enemy` | src/features/guest/CravingGame.tsx:369 | On the "order placed" screen, reached only by sending a round from this phone (GuestProgress.tsx:204, PlacedCraving) | Shown only after this phone sends a round to the kitchen. |
| `craving-stop` | src/features/guest/CravingGame.tsx:438 | On the "order placed" screen, reached only by sending a round from this phone (GuestProgress.tsx:204, PlacedCraving) | Shown only after this phone sends a round to the kitchen. |
| `guest-moved-open-link` | src/features/guest/GuestApp.tsx:449 | Shown only when staff have moved this phone's order to another table | Shown only after staff move an order to another table. |
| `guest-failed-retry` | src/features/guest/GuestClosure.tsx:546 | On the "payment failed" screen, reached only after reporting a failed payment | Shown only after a payment outcome is reported. |
| `guest-failed-pay-captain` | src/features/guest/GuestClosure.tsx:549 | On the "payment failed" screen, reached only after reporting a failed payment | Shown only after a payment outcome is reported. |
| `guest-menu-total-toggle` | src/features/guest/GuestOrdering.tsx:388 | Exist only while the cart holds something (or on the cart screen, reached only through Review order) | Shown only once a dish is in the cart, which is a write. |
| `guest-review-order` | src/features/guest/GuestOrdering.tsx:390 | Exist only while the cart holds something (or on the cart screen, reached only through Review order) | Shown only once a dish is in the cart, which is a write. |
| `guest-cart-back-to-menu` | src/features/guest/GuestOrdering.tsx:547 | Exist only while the cart holds something (or on the cart screen, reached only through Review order) | Shown only once a dish is in the cart, which is a write. |
| `guest-cart-total-toggle` | src/features/guest/GuestOrdering.tsx:612 | Exist only while the cart holds something (or on the cart screen, reached only through Review order) | Shown only once a dish is in the cart, which is a write. |
| `guest-add-something-else` | src/features/guest/GuestOrdering.tsx:628 | Exist only while the cart holds something (or on the cart screen, reached only through Review order) | Shown only once a dish is in the cart, which is a write. |
| `guest-see-my-order` | src/features/guest/GuestProgress.tsx:244 | On the "order placed" screen, reached only by sending a round from this phone (GuestProgress.tsx:204, PlacedCraving) | Shown only after this phone sends a round to the kitchen. |
| `guest-placed-order-more` | src/features/guest/GuestProgress.tsx:247 | On the "order placed" screen, reached only by sending a round from this phone (GuestProgress.tsx:204, PlacedCraving) | Shown only after this phone sends a round to the kitchen. |
| `guest-queue-start-link` | src/features/guest/GuestQueue.tsx:122 | Shown only to a party the owner has seated from the waitlist | Shown only after the party joined the queue and was seated. |
| `guest-sheet-loved` | src/features/guest/GuestSheets.tsx:366 | The parcel offer opens only after a heart is saved (GuestProgress.tsx:283) | Shown only after a favourite is saved. |
| `guest-loved-decline` | src/features/guest/GuestSheets.tsx:369 | The parcel offer opens only after a heart is saved (GuestProgress.tsx:283) | Shown only after a favourite is saved. |
| `owner-bridge-token` | src/features/owner/sections/PrintSetupSection.tsx:852 | The key sheet opens only after Issue key | Shown only after a bridge key is issued, which is a write. |
| `owner-bridge-token-done` | src/features/owner/sections/PrintSetupSection.tsx:854 | The key sheet opens only after Issue key | Shown only after a bridge key is issued, which is a write. |
| `owner-pin-sheet` | src/features/owner/sections/StaffSection.tsx:489 | The PIN sheet opens only after Reissue PIN | Shown only after a PIN is issued, which is a write. |
| `owner-pin-done` | src/features/owner/sections/StaffSection.tsx:491 | The PIN sheet opens only after Reissue PIN | Shown only after a PIN is issued, which is a write. |
| `owner-pin-copy` | src/features/owner/sections/StaffSection.tsx:510 | The PIN sheet opens only after Reissue PIN | Shown only after a PIN is issued, which is a write. |
| `staff-choose-pin-input` | src/features/staff/ChoosePin.tsx:143 | The "choose your own PIN" screen opens only for a provisional PIN; its purpose is setting a PIN | Shown only to a provisional PIN; its keypad sets a PIN. |
| `staff-choose-pin-error` | src/features/staff/ChoosePin.tsx:183 | The "choose your own PIN" screen opens only for a provisional PIN; its purpose is setting a PIN | Shown only to a provisional PIN; its keypad sets a PIN. |
| `staff-choose-key-*` | src/features/staff/ChoosePin.tsx:191 | The "choose your own PIN" screen opens only for a provisional PIN; its purpose is setting a PIN | Shown only to a provisional PIN; its keypad sets a PIN. |
| `staff-pin-error` | src/features/staff/PinSignIn.tsx:139 | Shown only after a wrong PIN is submitted, which counts towards the lock-out | Needs a failed sign-in attempt against a real account. |
| `staff-table-back` | src/features/staff/StaffTables.tsx:311 | Shown only when the selected bill disappeared while open (StaffTables.tsx:311, :846) | Shown only when a bill vanishes mid-view; cannot be staged read-only. |
| `staff-add-back` | src/features/staff/StaffTables.tsx:846 | Shown only when the selected bill disappeared while open (StaffTables.tsx:311, :846) | Shown only when a bill vanishes mid-view; cannot be staged read-only. |

## 5. No honest test-id selector

| test id or pattern | file:line | why it must not be pressed | suggested reason |
|---|---|---|---|
| `owner-closed-table` | src/features/owner/sections/Payments.tsx:147 | Its own controls (search, sort) are "owner-closed-table-…", which coverage matches to the owner-close* family; the flow searches it by role instead | Exercised by owner/payments#090 by role; no test-id selector credits it honestly. |
| `staff-add*` | src/features/staff/StaffTables.tsx:878 | "+ New dish" in Add items; staff-add-new-dish also matches the staff-add-* family, so coverage would credit the cart button | No selector reaches it without crediting the cart family; also a form. |
