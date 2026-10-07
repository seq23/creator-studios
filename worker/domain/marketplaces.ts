// Creator marketplaces and platform programs with real payouts: the Deals tab's "Get listed
// here" steps. This list must match docs/BRAND-SOURCES.md (same keys, same live status); a unit
// test reads that table. Every entry was checked on 25 Sep 2026 against the source named here.
// Eligibility is only ever claimed from a follower count the official page states; anything the
// dashboard cannot know (age, policies, a program's review) is a line she confirms herself.
import type { Platform } from "@shared/constants";

export interface Marketplace {
  key: string;
  name: string;
  live: "yes" | "no" | "unconfirmed";
  pays: string;
  qualifies: string;
  apply: string;
  applyUrl: string | null;
  sourceUrl: string;
  /** From the official page only; null when no official number exists. */
  minFollowers: number | null;
  /** Which of her platforms the follower bar reads; null = any public account. */
  platform: Platform | null;
  feeNote: string;
  /** Plain one-liner for the card: the payoff in her terms. */
  payoff: string;
}

export const MARKETPLACES_CHECKED_ON = "2026-09-25";

export const MARKETPLACES: Marketplace[] = [
  { key: "tiktok-one", name: "TikTok One (Creator Marketplace)", live: "yes", pays: "Brand-paid projects: a flat fee, a fee plus revenue share, or revenue share only.", qualifies: "18+, 1,000+ TikTok followers, follows TikTok's branded content rules.", apply: "TikTok app → Profile → TikTok Studio → Creator Marketplace. Fill in your rates and categories.", applyUrl: null, sourceUrl: "https://ads.tiktok.com/help/article/how-creators-can-sign-up-for-tiktok-one", minFollowers: 1000, platform: "tiktok", feeNote: "TikTok takes no service fee.", payoff: "Brands find you and send paid projects inside TikTok." },
  { key: "instagram-creator-marketplace", name: "Instagram Creator Marketplace", live: "yes", pays: "Brands propose paid partnerships; you agree the fee with them.", qualifies: "18+, public Creator or Business account, 1,000+ Instagram followers.", apply: "Instagram → Professional dashboard → Branded content → Creator Marketplace → opt in.", applyUrl: null, sourceUrl: "https://www.facebook.com/help/instagram/1389278101788752", minFollowers: 1000, platform: "instagram", feeNote: "Meta publishes no fee on creator pay.", payoff: "Brands search for creators like you and message offers." },
  { key: "youtube-creator-partnerships", name: "YouTube Creator Partnerships", live: "yes", pays: "Brand-paid sponsorships; Open Call pays to AdSense if your video is picked.", qualifies: "18+, in the YouTube Partner Program, no strikes.", apply: "Join the YouTube Partner Program, then YouTube Studio → Earn → Creator Partnerships.", applyUrl: "https://studio.youtube.com", sourceUrl: "https://support.google.com/youtube/answer/9385307?hl=en", minFollowers: null, platform: "youtube", feeNote: "No creator fee stated.", payoff: "Sponsorships offered inside YouTube Studio." },
  { key: "tiktok-shop-affiliate", name: "TikTok Shop Affiliate", live: "yes", pays: "Commission on sales from your videos; each seller sets the rate.", qualifies: "18+, US, ID check, 1,000+ TikTok followers (a 30-day starter pilot under 5,000).", apply: "TikTok Studio → Monetization → TikTok Shop → apply and verify your ID.", applyUrl: null, sourceUrl: "https://seller-us.tiktok.com/university/essay?knowledge_id=6939143037667118&lang=en", minFollowers: 1000, platform: "tiktok", feeNote: "No creator fee stated.", payoff: "Earn on every sale of the tableware and decor you already show." },
  { key: "amazon-influencer", name: "Amazon Influencer Program", live: "yes", pays: "Commission by category (Kitchen 4.5%, Home 3%), video commission, and Creator Connections brand campaigns.", qualifies: "A public Instagram, YouTube, TikTok or Facebook account; Amazon reviews each one.", apply: "Sign in on the Amazon influencer page, connect a social account, wait for review, then upload 3 product videos.", applyUrl: "https://affiliate-program.amazon.com/influencers", sourceUrl: "https://affiliate-program.amazon.com/influencers", minFollowers: null, platform: null, feeNote: "Free.", payoff: "A storefront for every product you use, plus paid brand campaigns." },
  { key: "ltk", name: "LTK", live: "yes", pays: "Commission set by each retailer, plus flat-fee brand campaigns.", qualifies: "An engaged public account; LTK reviews each application.", apply: "Fill in the LTK creator application and wait for review (1 to 3 weeks).", applyUrl: "https://company.shopltk.com/u/creator_blog_apply", sourceUrl: "https://company.shopltk.com/u/creator_blog_apply", minFollowers: null, platform: null, feeNote: "Free to join; LTK keeps part of the commission.", payoff: "Shoppable posts of your tables, and home brands that book LTK creators." },
  { key: "shopmy", name: "ShopMy", live: "yes", pays: "10–30% commission, gifting, codes and paid collabs; paid every Friday.", qualifies: "ShopMy reviews each creator; a referral speeds it up.", apply: "Apply to be a creator on ShopMy.", applyUrl: "https://shopmy.us/home/creators", sourceUrl: "https://shopmy.us/home/creators", minFollowers: null, platform: null, feeNote: "No creator fee stated.", payoff: "Home and lifestyle brands send paid collabs to ShopMy creators." },
  { key: "collabstr", name: "Collabstr", live: "yes", pays: "Packages at prices you set; the brand pays up front and the money is released when they approve.", qualifies: "Anyone; no follower minimum.", apply: "Create a profile and list your packages and prices.", applyUrl: "https://collabstr.com/creator", sourceUrl: "https://collabstr.com/creator", minFollowers: null, platform: null, feeNote: "About 15% is taken from your payout (2026 reviews).", payoff: "Brands buy your packages directly at your price." },
  { key: "aspire", name: "Aspire Creator Marketplace", live: "yes", pays: "Paid collabs, commission, gifting and ambassador programs; paid by PayPal.", qualifies: "1,000+ followers on Instagram, TikTok, YouTube or Pinterest.", apply: "Build a profile, connect your accounts, apply to campaigns.", applyUrl: "https://creators.aspireiq.com", sourceUrl: "https://www.aspire.io/influencers", minFollowers: 1000, platform: null, feeNote: "Free; no fee on your earnings.", payoff: "Apply to paid campaigns from home and lifestyle brands." },
  { key: "grin", name: "GRIN", live: "yes", pays: "Paid partnerships, commission and free product.", qualifies: "No minimum, no application.", apply: "Sign up, connect your accounts, get matched with brands.", applyUrl: "https://creators.grin.ai/", sourceUrl: "https://grin.co/creators", minFollowers: null, platform: null, feeNote: "Free for creators.", payoff: "Brands that run creator programs on GRIN can find and pay you." },
  { key: "hashtagpaid", name: "#paid", live: "yes", pays: "Brand campaigns at prices you set; paid within 45 days.", qualifies: "A public Instagram or TikTok account (brands set their own bar).", apply: "Join for free, connect your accounts, apply to briefs.", applyUrl: "https://hashtagpaid.com/create-account", sourceUrl: "https://hashtagpaid.com/creators", minFollowers: null, platform: null, feeNote: "Creator fee not published.", payoff: "Paid briefs, often with paid usage, from consumer brands." },
  { key: "upfluence", name: "Upfluence Creator Marketplace", live: "yes", pays: "Paid collabs, commission and free products.", qualifies: "No follower minimum.", apply: "Sign up, connect your accounts, apply to campaigns.", applyUrl: "https://creators.upfluence.com/sign-up", sourceUrl: "https://www.upfluence.com/upfluence-marketplace-creators", minFollowers: null, platform: null, feeNote: "Fee on creator pay not confirmed.", payoff: "E-commerce brands recruit creators here." },
  { key: "later-creators", name: "Later Creator Program", live: "yes", pays: "Commission paid every two weeks, plus brand campaigns at your rates.", qualifies: "Anyone for links; brand campaigns look for about 5,000+ followers.", apply: "Sign up as a creator with Later.", applyUrl: "https://later.com/influencer-creator-program/", sourceUrl: "https://later.com/influencer-creator-program/", minFollowers: null, platform: null, feeNote: "Free to join.", payoff: "Earn on links now; brand campaigns as you grow." },
  { key: "popular-pays", name: "Popular Pays", live: "yes", pays: "Brand gigs, paid within 30 days after the brief is met.", qualifies: "18+; each gig sets its own bar.", apply: "Install the Popular Pays app, link your accounts, apply to gigs.", applyUrl: "https://apps.apple.com/us/app/popular-pays-by-lightricks/id673760702", sourceUrl: "https://apps.apple.com/us/app/popular-pays-by-lightricks/id673760702", minFollowers: null, platform: null, feeNote: "No fee stated; recent reviews mention late payments.", payoff: "Content gigs for brands, including content-only work." },
];

export interface ListingStep {
  key: string;
  name: string;
  payoff: string;
  pays: string;
  apply: string;
  applyUrl: string | null;
  sourceUrl: string;
  joined: boolean;
  /** "ready" she meets the stated bar (or there is none); "not_yet" a stated bar she is under; "unknown" no stats for that platform. */
  status: "ready" | "not_yet" | "unknown";
  why: string;
}

/**
 * The "Get listed here" list: every live marketplace she has not joined, ready ones first. A
 * follower bar is judged only when the official page states one and we have her number for
 * that platform; otherwise it says what to check, never "you qualify".
 */
export function listingSteps(followers: Partial<Record<Platform, number>>, joined: string[]): ListingStep[] {
  const out: ListingStep[] = [];
  for (const m of MARKETPLACES) {
    if (m.live !== "yes") continue;
    let status: ListingStep["status"] = "ready";
    let why = m.qualifies;
    if (m.minFollowers !== null) {
      const have = m.platform ? followers[m.platform] : Math.max(0, ...Object.values(followers).filter((x): x is number => typeof x === "number"));
      if (have === undefined || (m.platform === null && !Object.keys(followers).length)) {
        status = "unknown";
        why = `Needs ${m.minFollowers.toLocaleString("en-US")}+ followers; connect your stats and we'll check.`;
      } else if (have < m.minFollowers) {
        status = "not_yet";
        why = `Needs ${m.minFollowers.toLocaleString("en-US")}+ followers; you have ${have.toLocaleString("en-US")}.`;
      } else {
        why = `You have ${have.toLocaleString("en-US")} followers; it asks for ${m.minFollowers.toLocaleString("en-US")}+. ${m.qualifies}`;
      }
    }
    out.push({ key: m.key, name: m.name, payoff: m.payoff, pays: m.pays, apply: m.apply, applyUrl: m.applyUrl, sourceUrl: m.sourceUrl, joined: joined.includes(m.key), status, why });
  }
  const rank = { ready: 0, unknown: 1, not_yet: 2 } as const;
  return out.sort((a, b) => Number(a.joined) - Number(b.joined) || rank[a.status] - rank[b.status]);
}

export const TIKTOK_ONE = MARKETPLACES[0];
