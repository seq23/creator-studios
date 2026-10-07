---
title: "Set up YouTube numbers"
group: getting_started
screen: setup
last_checked: 2026-10-07
keywords: youtube, stats, api key, google cloud, numbers
---

One card on Setup, about five minutes. Free accounts are enough.

## Find the YouTube numbers card

![Step 1](/help/screenshots/setup-youtube-numbers-1.png)
<!-- route: /setup -->
<!-- target: .setup-step:has(#setup-youtube_api) -->

Open **Setup** and find **YouTube numbers**. Until it has a key, Stats shows sample YouTube numbers marked practice.

## Make a key in Google Cloud

![Step 2](/help/screenshots/setup-youtube-numbers-2.png)
<!-- route: /setup -->
<!-- target: .setup-step:has(#setup-youtube_api) summary -->

Tap **Where to get it**. In **console.cloud.google.com** make a project, enable **YouTube Data API v3**, then **Credentials → Create credentials → API key**. Restrict it to that API.

## Paste it and tap Test key

![Step 3](/help/screenshots/setup-youtube-numbers-3.png)
<!-- route: /setup -->
<!-- target: role=textbox[name="YouTube numbers · API key"] -->

Paste the key and tap **Test key**. It reads one public YouTube list to check the key; nothing is changed.

## Tap Save

![Step 4](/help/screenshots/setup-youtube-numbers-4.png)
<!-- route: /setup -->
<!-- api: POST /api/setup/youtube_api/save {"fields":{"key":"good-demo-youtube"}} -->
<!-- target: .setup-step:has(#setup-youtube_api) .pill -->

Tap **Save**. Stats now reads your real public channel numbers.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
