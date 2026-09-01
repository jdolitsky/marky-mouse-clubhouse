# marky-mouse-clubhouse

![marky-mouse-clubhouse](./marky-mouse-clubhouse.jpeg)

This is a Chrome browser extension that provides the ability to make comments directly
on rendered Markdown in GitHub in order to make document review easier.

This is really something that should be built into GitHub itself.
Please upvote [this discussion](https://github.com/orgs/community/discussions/186730).

This does not require a GitHub API token etc. and instead uses your
browser session. For that reason, this will likely become dated as GitHub
makes UI updates.

This a fork of [sabbour/md-review-extension](https://github.com/sabbour/md-review-extension)
that has been largely modified to meet my needs.

## Installation

This would never make it into the Chrome Web Store so you have to install
it manually.

1. Clone this repository:
   ```bash
   git clone https://github.com/jdolitsky/marky-mouse-clubhouse.git
   ```
2. Open the Chrome extensions page: `chrome://extensions`
3. Enable "Developer mode" (top-right toggle)
4. Click "Load unpacked" and select the `marky-mouse-clubhouse/` directory

## Usage

After loading extension, on any GitHub PR with Markdown (`.md`) files,
click on the new "Docs review" tab.

## Claude?

Claude

## Why is it a clubhouse?

IYKYK
