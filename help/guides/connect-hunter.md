---
title: "Connect Hunter for brand emails (optional)"
group: getting_started
screen: connect
last_checked: 2026-09-26
keywords: hunter, brand email, contact, optional
fix: reconnect-hunter
---

Optional. Hunter helps the brand finder find public business emails like partnerships@ on a brand's website. It never looks up personal addresses.

## Make a free Hunter account

![Step 1](/help/screenshots/connect-hunter-1.png)
<!-- mock: hunter-sign-up -->

Open **hunter.io** and tap **Sign up**. The free plan (50 searches a month) is all you need.

## Copy your key

![Step 2](/help/screenshots/connect-hunter-2.png)
<!-- mock: hunter-api -->

In Hunter, open **API** and tap copy next to your key.

## Paste it and tap Check key

![Step 3](/help/screenshots/connect-hunter-3.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/hunter/disconnect -->
<!-- target: role=textbox[name="Brand deals · Hunter.io key"] -->

In the dashboard open **Settings**, then **Connect accounts**. Find **Hunter.io**, paste the key and tap **Check key**.

## It turns green

![Step 4](/help/screenshots/connect-hunter-4.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/hunter/key {"key":"good-demo-hunter"} -->
<!-- target: .card:has(h3:text-is("Hunter.io")) -->

The card turns green with the searches left this month. The finder uses it on its next run.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
