---
title: "Reconnect the AI writer (OpenRouter)"
group: fix_it
screen: connect
last_checked: 2026-09-26
keywords: the ai writer (openrouter), reconnect, key, not working, red
fix: connect-openrouter
---

The AI key stopped working. New captions and research wait until it's back.

## The card says what's wrong

![Step 1](/help/screenshots/reconnect-openrouter-1.png)
<!-- api: POST /api/connections/openrouter/key {"key":"bad-key-help-demo"} -->
<!-- target: .card:has(h3:text-is("OpenRouter")) -->

Open **Settings**, **Connect accounts**. The **OpenRouter** card says the key isn't working.

## Create a new key

![Step 2](/help/screenshots/reconnect-openrouter-2.png)
<!-- mock: openrouter-reconnect -->

Log in to OpenRouter. Create a new key, then copy the key.

## Paste the new key

![Step 3](/help/screenshots/reconnect-openrouter-3.png)
<!-- api: POST /api/connections/openrouter/key {"key":"bad-key-help-demo"} -->
<!-- target: role=textbox[name="AI · OpenRouter key"] -->

Tap **Disconnect** if you see it, paste the new key and tap **Check key**.

## The light turns green

![Step 4](/help/screenshots/reconnect-openrouter-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/openrouter/key {"key":"good-demo-openrouter"} -->
<!-- target: [data-health="openrouter"] -->

The card turns green, and so does its light on **Settings**.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
