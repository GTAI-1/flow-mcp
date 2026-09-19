#!/usr/bin/env node
// One-time setup: opens the dedicated Chrome profile on Flow so the user can sign in by hand.
import { getFlowPage, PROFILE_DIR } from "./chrome.js";

const page = await getFlowPage();
await page.bringToFront();
console.log(`Chrome is open on ${page.url()}`);
console.log(`Profile: ${PROFILE_DIR}`);
console.log("Sign in to Google in that window, then open or create a Flow project. The session is kept for next time.");
process.exit(0);
