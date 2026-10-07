---
title: "Set up clip cutting (job runner)"
group: getting_started
screen: setup
last_checked: 2026-10-07
keywords: github, jobs, cutting, clips, actions, token
fix: clips-look-wrong
---

One card on Setup, about five minutes. Free accounts are enough.

## Find the Clip cutting card

![Step 1](/help/screenshots/setup-job-runner-1.png)
<!-- route: /setup -->
<!-- target: .setup-step:has(#setup-github) -->

Open **Setup** and find **Clip cutting**. Until it is set up, a practice cutter makes sample clips so you can try Review.

## Copy the job repository

![Step 2](/help/screenshots/setup-job-runner-2.png)
<!-- route: /setup -->
<!-- target: .setup-step:has(#setup-github) summary -->

Tap **Where to get it**. Copy the studio job repository your host gives you into your free GitHub account, and add the secret **JOB_SHARED_SECRET** with the value shown on the card.

## Paste a token and the repository

![Step 3](/help/screenshots/setup-job-runner-3.png)
<!-- route: /setup -->
<!-- target: role=textbox[name="Clip cutting (job runner) · Repository"] -->

Make a fine-grained token for that repository only (Contents: read and write). Paste it and the repository name, then tap **Test key**.

## Tap Save

![Step 4](/help/screenshots/setup-job-runner-4.png)
<!-- route: /setup -->
<!-- api: POST /api/setup/github/save {"fields":{"token":"good-demo-token","repo":"you/your-studio-jobs"}} -->
<!-- target: .setup-step:has(#setup-github) .pill -->

Tap **Save**. Your next dump is cut on your own GitHub Actions.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
