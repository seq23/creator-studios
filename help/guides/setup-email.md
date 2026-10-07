---
title: "Set up Email (your own Resend)"
group: getting_started
screen: setup
last_checked: 2026-10-07
keywords: email, resend, alerts, notices, weekly recap
fix: i-didnt-get-an-email
---

One card on Setup, about five minutes. Free accounts are enough.

## Find the Email card

![Step 1](/help/screenshots/setup-email-1.png)
<!-- route: /setup -->
<!-- target: .setup-step:has(#setup-resend) -->

Open **Setup**. The first card is **Email**. Until it has a key, emails are listed on the health board but not sent.

## Make a Resend key

![Step 2](/help/screenshots/setup-email-2.png)
<!-- route: /setup -->
<!-- target: .setup-step:has(#setup-resend) summary -->

Tap **Where to get it**. Make a free account at **resend.com**, open **API Keys**, tap **Create API key** and copy it. To send from your own address, verify your domain in Resend and type the From address too.

## Paste it and tap Test key

![Step 3](/help/screenshots/setup-email-3.png)
<!-- route: /setup -->
<!-- target: role=textbox[name="Email · API key"] -->

Paste the key and tap **Test key**. It checks the key with one read-only request; nothing is sent or saved.

## Tap Save

![Step 4](/help/screenshots/setup-email-4.png)
<!-- route: /setup -->
<!-- api: POST /api/setup/resend/save {"fields":{"key":"good-demo-resend"}} -->
<!-- target: .setup-step:has(#setup-resend) .pill -->

Tap **Save**. The key is stored encrypted and the card says **Live**. Your alerts now come from your own Resend.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
