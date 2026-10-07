---
title: "Set up Instagram sign-in (stats)"
group: getting_started
screen: setup
last_checked: 2026-10-07
keywords: instagram, meta, app id, stats
---

One card on Setup, about five minutes. Free accounts are enough.

## Find the Instagram sign-in card

![Step 1](/help/screenshots/setup-instagram-sign-in-1.png)
<!-- route: /setup -->
<!-- target: .setup-step:has(#setup-meta_app) -->

Open **Setup** and find **Instagram sign-in**. It is optional: Stats works without it, and until it is set up the sign-in is a practice one.

## Make a Meta app

![Step 2](/help/screenshots/setup-instagram-sign-in-2.png)
<!-- route: /setup -->
<!-- target: .setup-step:has(#setup-meta_app) summary -->

Tap **Where to get it**. At **developers.facebook.com** create a Business app, add **Instagram Login** with the redirect address shown, then copy the **App ID** and **App secret**.

## Paste them and tap Test key

![Step 3](/help/screenshots/setup-instagram-sign-in-3.png)
<!-- route: /setup -->
<!-- target: role=textbox[name="Instagram sign-in (stats) · App ID"] -->

Paste both and tap **Test key**. Meta is asked once whether the pair is real.

## Tap Save

![Step 4](/help/screenshots/setup-instagram-sign-in-4.png)
<!-- route: /setup -->
<!-- api: POST /api/setup/meta_app/save {"fields":{"app_id":"1234567890","app_secret":"good-demo-secret"}} -->
<!-- target: .setup-step:has(#setup-meta_app) .pill -->

Tap **Save**. **Connect Instagram** on Settings now opens Instagram's own sign-in.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
