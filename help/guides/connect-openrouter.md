---
title: "Connect the AI writer (OpenRouter, free)"
group: getting_started
screen: connect
last_checked: 2026-09-26
keywords: ai, captions, openrouter, research, writing
fix: reconnect-openrouter
---

The AI writes your captions, research brief and brand emails. It uses free models, so it costs nothing.

## Open OpenRouter's Keys page

![Step 1](/help/screenshots/connect-openrouter-1.png)
<!-- mock: openrouter-keys -->

Open **openrouter.ai**, sign in (a free account is enough), then open **Keys**.

## Create a key

![Step 2](/help/screenshots/connect-openrouter-2.png)
<!-- mock: openrouter-create -->

Tap **Create Key**, name it Sample Studio, leave the credit limit empty and tap **Create**.

## Copy the key

![Step 3](/help/screenshots/connect-openrouter-3.png)
<!-- mock: openrouter-copy -->

Copy the key. It starts with sk-or- and is shown only once.

## Paste it and tap Check key

![Step 4](/help/screenshots/connect-openrouter-4.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/openrouter/disconnect -->
<!-- target: role=textbox[name="AI · OpenRouter key"] -->

In the dashboard open **Settings**, then **Connect accounts**. Find **OpenRouter**, paste the key and tap **Check key**.

## It turns green

![Step 5](/help/screenshots/connect-openrouter-5.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/openrouter/key {"key":"good-demo-openrouter"} -->
<!-- target: .card:has(h3:text-is("OpenRouter")) -->

The card turns green. Free models are used, so it costs nothing.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
