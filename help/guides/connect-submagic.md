---
title: "Connect Submagic (optional)"
group: getting_started
screen: connect
last_checked: 2026-09-26
keywords: submagic, editor, editing app, optional
fix: reconnect-submagic
---

Submagic adds animated captions to your clips using your Submagic credits, instead of the built-in editor. Everything works without it.

## Create a key in Submagic

![Step 1](/help/screenshots/connect-submagic-1.png)
<!-- mock: submagic-api -->

Log in at **submagic.co** and open its API page (the Business + API plan). Create a key named {{studio}} and copy it.

## Paste it and tap Check key

![Step 2](/help/screenshots/connect-submagic-2.png)
<!-- route: /settings/connections -->
<!-- target: role=textbox[name="Editor · Submagic key"] -->

In the dashboard open **Settings**, then **Connect accounts**, **Editing apps**. Paste the key in the **Submagic** card and tap **Check key**.

## It turns green

![Step 3](/help/screenshots/connect-submagic-3.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/submagic/key {"key":"good-submagic-demo-key"} -->
<!-- target: .card:has(h3:text-is("Submagic")) -->

The **Submagic** card says it's connected and its light is green.

## Pick Submagic under Editing

![Step 4](/help/screenshots/connect-submagic-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/submagic/key {"key":"good-submagic-demo-key"} -->
<!-- api: PATCH /api/editing {"editors":{"caption":"submagic"}} -->
<!-- target: #editor-caption -->

Open **Settings**, then **Editing**. Under **Captions**, pick **Submagic**. Your next dump uses it.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
