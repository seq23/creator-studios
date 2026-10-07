---
title: "The job runner stopped"
group: fix_it
screen: settings
last_checked: 2026-09-26
keywords: job runner, github, clips not cutting, stuck, jobs
fix: connect-github
---

The job runner that cuts your clips stopped. Dumps wait safely until it's back.

## Job runner (GitHub) is red

![Step 1](/help/screenshots/reconnect-github-1.png)
<!-- light: Job runner (GitHub) | red | The job token was refused, so jobs can't start -->
<!-- target: [data-health="Job runner (GitHub)"] -->

In **Settings**, **Job runner (GitHub)** says **Not working**.

## Your helper renews the token

![Step 2](/help/screenshots/reconnect-github-2.png)
<!-- mock: github-token-expired -->

Send this page to your helper. They renew the job token in GitHub.

## Press Dump again

![Step 3](/help/screenshots/reconnect-github-3.png)
<!-- route: /dump -->
<!-- target: main a.list-row >> nth=0 -->

When it's green, open **Dump** and press **Dump** again on any dump that failed.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
