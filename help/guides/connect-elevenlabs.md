---
title: "Connect ElevenLabs for the premium voice (optional)"
group: getting_started
screen: connect
last_checked: 2026-09-26
keywords: elevenlabs, premium voice, voice over, clone
fix: reconnect-elevenlabs
---

Your voice overs always work with the free built-in voice. Connect your own ElevenLabs account for the premium voice: best quality, seconds each, paid from your ElevenLabs credits.

## Open API keys in ElevenLabs

![Step 1](/help/screenshots/connect-elevenlabs-1.png)
<!-- mock: elevenlabs-home -->

Log in at **elevenlabs.io**. Tap your profile at the bottom left, then **API keys**. Starter and above include voice cloning.

## Create a key

![Step 2](/help/screenshots/connect-elevenlabs-2.png)
<!-- mock: elevenlabs-create -->

Tap **Create API key**, name it {{studio}}, leave the access as it is and tap **Create**.

## Copy the key

![Step 3](/help/screenshots/connect-elevenlabs-3.png)
<!-- mock: elevenlabs-copy -->

Copy the key. ElevenLabs shows it only once.

## Paste it and tap Check key

![Step 4](/help/screenshots/connect-elevenlabs-4.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/elevenlabs/disconnect -->
<!-- target: role=textbox[name="Voice overs · ElevenLabs (premium) key"] -->

In the dashboard open **Settings**, then **Connect accounts**. Under **Voice overs · premium**, paste the key and tap **Check key**.

## See your plan and credits

![Step 5](/help/screenshots/connect-elevenlabs-5.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/elevenlabs/key {"key":"good-demo-creator"} -->
<!-- target: [data-testid="elevenlabs-plan"] -->

The card shows your plan, the characters used this month and whether cloning is on your plan. Your premium voice is made from the voice you saved.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
