---
title: "Connect Buffer (this is how your posts go out)"
group: getting_started
screen: connect
last_checked: 2026-09-26
keywords: post, posting, publish, buffer, schedule, key
fix: reconnect-buffer
---

Buffer is the free service that publishes your clips to TikTok, Instagram and YouTube. You connect it once.

## Make a free Buffer account

![Step 1](/help/screenshots/connect-buffer-1.png)
<!-- mock: buffer-sign-up -->

Open **publish.buffer.com** and sign up for the free plan (or log in).

## Open Settings, then API

![Step 2](/help/screenshots/connect-buffer-2.png)
<!-- mock: buffer-settings-api -->

In Buffer, tap your picture, then **Settings**, then **API**.

## Create a key and copy it

![Step 3](/help/screenshots/connect-buffer-3.png)
<!-- mock: buffer-create-key -->

Tap **Create key**, name it Dashboard, and tap **Copy**.

## Open Connect accounts

![Step 4](/help/screenshots/connect-buffer-4.png)
<!-- route: /settings -->
<!-- target: a.btn[href="/settings/connections"] -->

In the dashboard, open **Settings** and tap **Connect accounts**.

## Paste the key and tap Check key

![Step 5](/help/screenshots/connect-buffer-5.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/buffer/disconnect -->
<!-- target: role=textbox[name="Posting · Buffer key"] -->

Under **Posting · Buffer**, paste the key and tap **Check key**.

## Check your channels

![Step 6](/help/screenshots/connect-buffer-6.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/buffer/key {"key":"good-key-e2e-000"} -->
<!-- target: .card:has(h3:text-is("Buffer")) -->

The card turns green and lists the channels it found. If TikTok, Instagram or YouTube is missing, follow **Add TikTok, Instagram and YouTube in Buffer**.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
