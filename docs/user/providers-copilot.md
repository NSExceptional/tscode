# GitHub Copilot

GitHub Copilot is available two ways:

- **GitHub Copilot (SDK)** drives the `copilot` CLI through GitHub's Copilot SDK. It shows each
  model's reasoning-effort and long-context options, Copilot's slash commands and skills, and plan
  mode proposals.
- **GitHub Copilot** through the [ACP Registry](./providers-acp.md) runs `copilot --acp`.

Both use the same CLI install and sign-in, so you can add either or both and pick per thread.

## Set up

1. Install the [GitHub Copilot CLI](https://github.com/github/copilot-cli) on the server and run
   `copilot` once to sign in with `/login`.
2. Open **Settings → Providers**, select **Add provider**, and choose **GitHub Copilot (SDK)**.
3. If T3 Code cannot find `copilot`, set its **Binary path**.

## Notes

- Slash commands that only print text, such as `/skills`, reply in the thread without starting a
  model turn.
- Rewinding a thread restores files but does not rewind Copilot's conversation.
- While **GitHub Copilot (SDK)** is enabled, Copilot CLI sessions from the last 30 days appear
  as threads in the project for their folder within a few minutes, so you can continue a session
  started in the terminal or VS Code. Only projects you have already added receive sessions.
- When you continue a Copilot thread's session in the terminal or VS Code, those messages appear in
  the thread a few minutes after that client goes quiet. Tool activity is not copied.
- **Sync settled with VS Code** (in the provider's settings) settles a thread when you mark its
  session done in VS Code, and marks the session done when you settle the thread. VS Code shows the
  change the next time it opens that folder. Neither side is ever unsettled or un-done for you.
