---
title: "Connect Descript (optional)"
group: getting_started
screen: connect
last_checked: 2026-09-26
keywords: descript, editor, editing app, optional
fix: reconnect-descript
---

Descript polishes each clip (clean sound, filler words out) using your Descript credits, instead of the built-in editor. Everything works without it.

## Create a key in Descript

![Step 1](/help/screenshots/connect-descript-1.png)
<!-- mock: descript-api -->

Log in at **descript.com** and open its API page (paid plans). Create a key named {{studio}} and copy it.

## Paste it and tap Check key

![Step 2](/help/screenshots/connect-descript-2.png)
<!-- route: /settings/connections -->
<!-- target: role=textbox[name="Editor · Descript key"] -->

In the dashboard open **Settings**, then **Connect accounts**, **Editing apps**. Paste the key in the **Descript** card and tap **Check key**.

## It turns green

![Step 3](/help/screenshots/connect-descript-3.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/descript/key {"key":"good-descript-demo-key"} -->
<!-- target: .card:has(h3:text-is("Descript")) -->

The **Descript** card says it's connected and its light is green.

## Pick Descript under Editing

![Step 4](/help/screenshots/connect-descript-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/descript/key {"key":"good-descript-demo-key"} -->
<!-- api: PATCH /api/editing {"editors":{"enhance":"descript"}} -->
<!-- target: #editor-enhance -->

Open **Settings**, then **Editing**. Under **Polish**, pick **Descript**. Your next dump uses it.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
