---
title: "Connect your Facebook Page"
group: getting_started
screen: setup
last_checked: 2026-10-22
fix: reconnect-facebook
keywords: facebook, page, page token, connect facebook, post to facebook
---

Your photo posts go to your Facebook Page once it is connected. Until then they wait safely on Photos.

## Find Facebook Page on Setup

![Step 1](/help/screenshots/connect-facebook-1.png)
<!-- target: #setup-facebook -->

Open **Setup** and find the **Facebook Page** card.

## Get a Page token

![Step 2](/help/screenshots/connect-facebook-2.png)
<!-- target: #setup-facebook a.btn -->

Tap **Open Graph API Explorer**, pick your Page, and add **pages_manage_posts**. Tap **Generate Access Token**, then make it long-lived in the Access Token Debugger.

## Paste it and save

![Step 3](/help/screenshots/connect-facebook-3.png)
<!-- target: #setup-facebook button[type="submit"] -->

Paste your Page ID and the Page token, then tap **Save**. Posts that were waiting are planned again, with a heads-up first.

## Did this work?

If not, tap **No** below and we'll email your helper.
