---
title: "Connect faster web research (Firecrawl, optional)"
group: getting_started
screen: connect
last_checked: 2026-09-26
keywords: web research, firecrawl, search, optional
fix: reconnect-firecrawl
---

Optional. Research and the brand finder already search the web for free. Firecrawl is a faster search.

## Make a free Firecrawl account

![Step 1](/help/screenshots/connect-firecrawl-1.png)
<!-- mock: firecrawl-sign-up -->

You don't need this: the dashboard searches the web for free on its own. For faster research, open **firecrawl.dev** and sign up (1,000 free credits a month).

## Copy your key

![Step 2](/help/screenshots/connect-firecrawl-2.png)
<!-- mock: firecrawl-keys -->

Open **API Keys** and copy your key (it starts with fc-).

## Paste it and tap Check key

![Step 3](/help/screenshots/connect-firecrawl-3.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/firecrawl/disconnect -->
<!-- target: role=textbox[name="Web research · Firecrawl key"] -->

In the dashboard open **Settings**, then **Connect accounts**. Find **Firecrawl**, paste the key and tap **Check key**.

## It turns green

![Step 4](/help/screenshots/connect-firecrawl-4.png)
<!-- route: /settings/connections -->
<!-- api: POST /api/connections/firecrawl/key {"key":"good-demo-firecrawl"} -->
<!-- target: .card:has(h3:text-is("Firecrawl")) -->

The card turns green and shows the credits left. If it ever runs out, the free search takes over.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
