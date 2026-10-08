---
title: "Connect Klap (optional)"
group: getting_started
screen: connect
last_checked: 2026-09-26
keywords: klap, editor, editing app, optional
fix: reconnect-klap
---

Klap adds captions to your clips using your Klap credits, instead of the built-in editor. Everything works without it.

## Create a key in Klap

![Step 1](/help/screenshots/connect-klap-1.png)
<!-- mock: klap-api -->

Log in at **klap.app** and open its API page (paid plans). Create a key named {{studio}} and copy it.

## Paste it and tap Check key

![Step 2](/help/screenshots/connect-klap-2.png)
<!-- route: /settings/connections -->
<!-- target: role=textbox[name="Editor · Klap key"] -->

In the dashboard open **Settings**, then **Connect accounts**, **Editing apps**. Paste the key in the **Klap** card and tap **Check key**.

## It turns green

![Step 3](/help/screenshots/connect-klap-3.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/klap/key {"key":"good-klap-demo-key"} -->
<!-- target: .card:has(h3:text-is("Klap")) -->

The **Klap** card says it's connected and its light is green.

## Pick Klap under Editing

![Step 4](/help/screenshots/connect-klap-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/klap/key {"key":"good-klap-demo-key"} -->
<!-- api: PATCH /api/editing {"editors":{"caption":"klap"}} -->
<!-- target: #editor-caption -->

Open **Settings**, then **Editing**. Under **Captions**, pick **Klap**. Your next dump uses it.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
