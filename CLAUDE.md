# Working on this repo

Railway deploys the repository's default branch (`claude/quoting-ai-agent-dashboard-8lgc9n`) automatically.
Finished work should land there without the owner having to manage branches.

When a change is complete:

1. Run `npm test` and fix anything that fails. For UI changes, also check the page in a browser.
2. Commit and push to your working branch.
3. Open a pull request into the default branch, wait for the **Test** check (GitHub Actions) to pass,
   then merge it. Don't merge while the check is red.
4. Tell the owner it's merged and on its way to Railway.

Don't push straight to the default branch; always go through a pull request so the tests run first.
