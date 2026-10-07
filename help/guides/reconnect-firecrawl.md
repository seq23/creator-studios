---
title: "Reconnect web research (Firecrawl)"
group: fix_it
screen: connect
last_checked: 2026-09-26
keywords: web research (firecrawl), reconnect, key, not working, red
fix: connect-firecrawl
---

The Firecrawl key stopped working or its credits ran out. Research keeps working with the free search meanwhile.

## The card says what's wrong

![Step 1](/help/screenshots/reconnect-firecrawl-1.png)
<!-- api: POST /api/connections/firecrawl/key {"key":"bad-key-help-demo"} -->
<!-- target: .card:has(h3:text-is("Firecrawl")) -->

Open **Settings**, **Connect accounts**. The **Firecrawl** card says the key isn't working.

## Check the credits, or copy the key again

![Step 2](/help/screenshots/reconnect-firecrawl-2.png)
<!-- mock: firecrawl-usage -->

Log in to Firecrawl. Check the credits, or copy the key again, then copy the key.

## Paste the new key

![Step 3](/help/screenshots/reconnect-firecrawl-3.png)
<!-- api: POST /api/connections/firecrawl/key {"key":"bad-key-help-demo"} -->
<!-- target: role=textbox[name="Web research · Firecrawl key"] -->

Tap **Disconnect** if you see it, paste the new key and tap **Check key**.

## The light turns green

![Step 4](/help/screenshots/reconnect-firecrawl-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/firecrawl/key {"key":"good-demo-firecrawl"} -->
<!-- target: [data-health="firecrawl"] -->

The card turns green, and so does its light on **Settings**.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
