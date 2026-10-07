---
title: "Connect Opus Clip (optional)"
group: getting_started
screen: connect
last_checked: 2026-09-26
keywords: opus clip, editor, editing app, optional
fix: reconnect-opusclip
---

Opus Clip cuts your dumps into clips using your Opus Clip credits, instead of the built-in editor. Everything works without it.

## Create a key in Opus Clip

![Step 1](/help/screenshots/connect-opusclip-1.png)
<!-- mock: opusclip-api -->

Log in at **opus.pro** and open its API page (Pro, Max or Business plans). Create a key named Sample Studio and copy it.

## Paste it and tap Check key

![Step 2](/help/screenshots/connect-opusclip-2.png)
<!-- route: /settings/connections -->
<!-- target: role=textbox[name="Editor · Opus Clip key"] -->

In the dashboard open **Settings**, then **Connect accounts**, **Editing apps**. Paste the key in the **Opus Clip** card and tap **Check key**.

## It turns green

![Step 3](/help/screenshots/connect-opusclip-3.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/opusclip/key {"key":"good-opusclip-demo-key"} -->
<!-- target: .card:has(h3:text-is("Opus Clip")) -->

The **Opus Clip** card says it's connected and its light is green.

## Pick Opus Clip under Editing

![Step 4](/help/screenshots/connect-opusclip-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/opusclip/key {"key":"good-opusclip-demo-key"} -->
<!-- api: PATCH /api/editing {"editors":{"cut_from_source":"opusclip"}} -->
<!-- target: #editor-cut_from_source -->

Open **Settings**, then **Editing**. Under **Cutting a dump into clips**, pick **Opus Clip**. Your next dump uses it.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
