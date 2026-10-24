#!/usr/bin/env node
// One-time setup per account: opens that account's own Chrome profile on Flow so the user can sign in by hand.
// npm run login            -> the main account
// npm run login -- work    -> the account called "work" (created first if it does not exist yet)
import { accountByName, addAccount, listAccounts, MAIN, profileDir } from "./accounts.js";
import { getFlowPage } from "./chrome.js";

const name = process.argv[2] ?? MAIN;
const account = listAccounts().find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? addAccount(name);
const page = await getFlowPage(accountByName(account.name));
await page.bringToFront();
console.log(`Chrome for account "${account.name}" is open on ${page.url()}`);
console.log(`Profile: ${profileDir(account)}`);
console.log("Sign in to Google in that window, then open or create a Flow project. The session is kept for next time.");
process.exit(0);
