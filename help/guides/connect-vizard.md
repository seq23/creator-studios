---
title: "Connect Vizard (optional)"
group: getting_started
screen: connect
last_checked: 2026-09-26
keywords: vizard, editor, editing app, optional
fix: reconnect-vizard
---

Vizard cuts your dumps into clips using your Vizard credits, instead of the built-in editor. Everything works without it.

## Create a key in Vizard

![Step 1](/help/screenshots/connect-vizard-1.png)
<!-- mock: vizard-api -->

Log in at **vizard.ai** and open its API page (paid plans). Create a key named Sample Studio and copy it.

## Paste it and tap Check key

![Step 2](/help/screenshots/connect-vizard-2.png)
<!-- route: /settings/connections -->
<!-- target: role=textbox[name="Editor · Vizard key"] -->

In the dashboard open **Settings**, then **Connect accounts**, **Editing apps**. Paste the key in the **Vizard** card and tap **Check key**.

## It turns green

![Step 3](/help/screenshots/connect-vizard-3.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/vizard/key {"key":"good-vizard-demo-key"} -->
<!-- target: .card:has(h3:text-is("Vizard")) -->

The **Vizard** card says it's connected and its light is green.

## Pick Vizard under Editing

![Step 4](/help/screenshots/connect-vizard-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/vizard/key {"key":"good-vizard-demo-key"} -->
<!-- api: PATCH /api/editing {"editors":{"cut_from_source":"vizard"}} -->
<!-- target: #editor-cut_from_source -->

Open **Settings**, then **Editing**. Under **Cutting a dump into clips**, pick **Vizard**. Your next dump uses it.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
