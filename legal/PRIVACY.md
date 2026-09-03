# Privacy Policy

**Effective date:** August 21, 2026  
**Product:** Echo (the “App”)

This policy describes how the App handles information. It is written to match how the software actually works. It is not legal advice.

## Summary

The App runs on **your computer**. It does not create an account with us, and it does not upload your browsing to our servers. Pages you open, cookies, downloads, and test reports stay in the App’s local data folder unless **you** send them somewhere else (for example by connecting Cursor, Claude Desktop, or another MCP client).

## What stays on your device

- **Browsing profile:** cookies, site storage, and history for this App only (not your Google Chrome profile).
- **Downloads, screenshots, recordings, and test runs:** saved under the App user data folder you can open from Settings → System.
- **Recordings:** if you use Record, the App stores the steps you took (URLs, clicks, and text you typed, including form fields) in that local folder.
- **MCP token:** a local secret so only programs you configure can call the App’s tools. The MCP server listens on this computer and, with that token, on your local network.

We do not operate a cloud database of your visits.

## What other companies may see

When you visit a website or search Google, **that site** (and its ads, analytics, and captcha providers) can see your request, IP address, and cookies, under **their** policies.

If you click **Connect** for Cursor or Claude Desktop, or paste an MCP snippet into another assistant, those apps can drive this browser. While connected, they can see page content, screenshots, and anything you are signed in to here. Their privacy policies apply to how they handle that data.

- If you turn on **Sessions and state**, an assistant can read the cookies and storage for sites you are signed in to, including sign-in tokens, and clear that data.

## What we do not collect

The App does not include an account system, advertising ID, or our own analytics/telemetry. We do not sell your browsing data.

## Crash and system data

The App is built on Electron and Chromium. Those components may write local logs. We do not enable a separate “phone home” analytics service in this App.

## Update checks

On Windows and Linux, the App checks GitHub's public release feed roughly every 4 hours for a newer version, and downloads it in the background if one exists. On Mac, the App checks the same feed and shows a notice if a newer version exists, without downloading anything. This request necessarily shares your IP address and the App's version with GitHub's servers, the same as loading any public web page. It is the only outbound network request the App makes on its own initiative, as opposed to sites you navigate to.

## Children

The App is not directed at children under 13. Do not connect an assistant to a profile used by a child.

## Your choices

- Do not click Connect (or share the token / network URL) if you do not want an assistant to see this browser.
- Sign out of sites you do not want an assistant to view.
- Delete the App user data folder to wipe the local profile, downloads, and token.
- Uninstall the App to stop the local MCP server.

## Changes

We may update this policy when the App changes. The effective date at the top will change.

## Contact

For questions about this App, use the project repository or the contact method provided with your download.
