---
title: "Reconnect ElevenLabs"
group: fix_it
screen: connect
last_checked: 2026-09-26
keywords: elevenlabs, reconnect, key, not working, red
fix: connect-elevenlabs
---

ElevenLabs refused the key or your credits ran out. Every voice over uses your free built-in voice meanwhile.

## The card says what's wrong

![Step 1](/help/screenshots/reconnect-elevenlabs-1.png)
<!-- api: POST /api/connections/elevenlabs/key {"key":"bad-key-help-demo"} -->
<!-- target: .card:has(h3:text-is("ElevenLabs")) -->

Open **Settings**, **Connect accounts**. The **ElevenLabs** card says the key isn't working.

## Check your credits, or make a new key

![Step 2](/help/screenshots/reconnect-elevenlabs-2.png)
<!-- mock: elevenlabs-credits -->

Log in to ElevenLabs. Check your credits, or make a new key, then copy the key.

## Paste the new key

![Step 3](/help/screenshots/reconnect-elevenlabs-3.png)
<!-- api: POST /api/connections/elevenlabs/key {"key":"bad-key-help-demo"} -->
<!-- target: role=textbox[name="Voice overs · ElevenLabs (premium) key"] -->

Tap **Disconnect** if you see it, paste the new key and tap **Check key**.

## The light turns green

![Step 4](/help/screenshots/reconnect-elevenlabs-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/elevenlabs/key {"key":"good-demo-creator"} -->
<!-- target: [data-health="Voice · ElevenLabs"] -->

The card turns green, and so does its light on **Settings**.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
