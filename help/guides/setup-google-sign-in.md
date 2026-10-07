---
title: "Set up Google sign-in (YouTube uploads)"
group: getting_started
screen: setup
last_checked: 2026-10-07
keywords: google, oauth, client id, youtube upload, full videos
fix: reconnect-youtube
---

One card on Setup, about five minutes. Free accounts are enough.

## Find the Google sign-in card

![Step 1](/help/screenshots/setup-google-sign-in-1.png)
<!-- route: /setup -->
<!-- target: .setup-step:has(#setup-google_app) -->

Open **Setup** and find **Google sign-in**. Until it is set up, Connect YouTube makes a practice connection and uploads are simulated.

## Make a web sign-in client

![Step 2](/help/screenshots/setup-google-sign-in-2.png)
<!-- route: /setup -->
<!-- target: .setup-step:has(#setup-google_app) summary -->

Tap **Where to get it**. In Google Cloud set the **OAuth consent screen** to External, then **Create credentials → OAuth client ID → Web application**, and add the redirect address shown on the card.

## Paste the Client ID and secret

![Step 3](/help/screenshots/setup-google-sign-in-3.png)
<!-- route: /setup -->
<!-- target: role=textbox[name="Google sign-in (YouTube uploads) · Client ID"] -->

Paste the **Client ID** and the **Client secret**, then tap **Test key**. Google is asked once whether the pair is real; nothing is granted.

## Tap Save, then Connect YouTube

![Step 4](/help/screenshots/setup-google-sign-in-4.png)
<!-- route: /setup -->
<!-- api: POST /api/setup/google_app/save {"fields":{"client_id":"demo.apps.googleusercontent.com","client_secret":"good-demo-secret"}} -->
<!-- target: .setup-step:has(#setup-google_app) .pill -->

Tap **Save**. Then open **Settings → Connect accounts** and tap **Connect YouTube** to sign in with your channel.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
