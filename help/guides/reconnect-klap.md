---
title: "Reconnect Klap"
group: fix_it
screen: connect
last_checked: 2026-09-26
keywords: klap, reconnect, key, not working, red
fix: connect-klap
---

Klap's key stopped working or it's out of credits. The built-in editor does its job meanwhile.

## The card says what's wrong

![Step 1](/help/screenshots/reconnect-klap-1.png)
<!-- api: POST /api/connections/klap/key {"key":"bad-key-help-demo"} -->
<!-- target: .card:has(h3:text-is("Klap")) -->

Open **Settings**, **Connect accounts**. The **Klap** card says the key isn't working.

## Top up, or make a new key

![Step 2](/help/screenshots/reconnect-klap-2.png)
<!-- mock: klap-credits -->

Log in to Klap. Top up, or make a new key, then copy the key.

## Paste the new key

![Step 3](/help/screenshots/reconnect-klap-3.png)
<!-- api: POST /api/connections/klap/key {"key":"bad-key-help-demo"} -->
<!-- target: role=textbox[name="Editor · Klap key"] -->

Tap **Disconnect** if you see it, paste the new key and tap **Check key**.

## The light turns green

![Step 4](/help/screenshots/reconnect-klap-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/klap/key {"key":"good-klap-demo-key"} -->
<!-- target: [data-health="klap"] -->

The card turns green, and so does its light on **Settings**.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
