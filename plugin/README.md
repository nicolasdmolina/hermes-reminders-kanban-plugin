# Hermes Reminders Kanban

Turn Apple Reminders into a Kanban board in Hermes Desktop, where you can hand a task to Hermes and review the result.

![Reminders in the Hermes sidebar, with one card in progress and one checked off][hero-image]

<details>
<summary><strong>Watch the 70-second demo</strong></summary>

https://github.com/user-attachments/assets/af782ab9-aed8-4bbd-91bd-22add93a92d8

[Open the video][demo-video-url] · [Download the MP4](/docs/media/demo.mp4?raw=true)

</details>

In the demo, Hermes asks “Which blue?” Watch what happens when you answer “Navy, please.” The recording uses plugin beta.3 in Hermes Desktop, an Apple Reminders test list, and real scheduled jobs. A scripted model supplies the replies.

## From a reminder to a result

Choose which Apple Reminders lists to show. Edit a title, note, due date, priority, or list on the board and the change saves back to Apple Reminders. Filter the board to see your own tasks, delegated work, or recurring reminders.

1. **Delegate a card.** Open a reminder in **To do** and choose **Delegate**, or move it to **Ready for Agent**. Turn on **Agent pickup** when you want Hermes to start queued tasks.
2. **Follow the work.** The running Hermes gateway picks up the card as a scheduled job and moves it to **In progress**. If Hermes asks a question, the card moves to **Needs you**. Open it, type your reply, and send it back.
3. **Review the result.** The card returns to **Needs you**. Ask for changes or choose **Accept**. Accepting checks off the original reminder in Apple Reminders and moves the card to **Done**.

For a repeating reminder, you can delegate one occurrence or every due occurrence. Each result still comes back for review.

## Install on your Mac

Use macOS 14 or later, Hermes Desktop with Hermes 0.23.1 or later, and Apple's Xcode Command Line Tools. Open Terminal to install the plugin from the [Hermes Marketplace](https://hermes-agent.nousresearch.com/marketplace/reminders-kanban).

```sh
hermes plugins install reminders-kanban --enable
hermes plugins doctor reminders-kanban
```

<details>
<summary>Install from a clean Git checkout</summary>

These commands fetch the beta.4 release the Marketplace reviewed and install its built plugin. Use the same commit if you build beta.4 yourself.

```sh
git clone --single-branch https://github.com/nicolasdmolina/hermes-reminders-kanban-plugin.git
cd hermes-reminders-kanban-plugin
git fetch origin cc4c7784d6976c3cd6d6ed0879356557ad451481
git switch --detach FETCH_HEAD
hermes plugins install "file://$PWD#plugin" --ref "$(git rev-parse HEAD)" --enable
hermes plugins doctor reminders-kanban
```

Hermes identifies the local checkout as a custom source. A successful doctor check reports two registered tools.

</details>

In Hermes Desktop, open **Capabilities > Plugins** and enable **Reminders Kanban**. Rescan if it hasn't appeared yet. Open **Reminders** in the sidebar, choose **Set up Reminders access** if prompted, and allow access in macOS. Select your lists and preview the board.

## What runs on your Mac

Hermes uses your profile's model and its scheduled-job approval settings. Delegated titles, notes, and replies go to your configured model provider. Keep the gateway running for background work. Turning pickup off stops new automatic starts.

Board settings and task history live in your local Hermes profile. When you delegate a reminder, the plugin adds a line to its notes identifying the Mac working on it. If you've set up task links, that line also opens the card in Hermes.

This is a macOS preview. Use one Mac for execution. Setup on a brand-new macOS account and iPhone-to-Mac iCloud sync still need verification. For local signing, permission recovery, and optional private task links on another device, see the [installation guide](docs/installation.md).

[Source on GitHub][repository] · [Build and test](docs/development.md) · [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

[repository]: https://github.com/nicolasdmolina/hermes-reminders-kanban-plugin
[demo-video-url]: https://github.com/user-attachments/assets/af782ab9-aed8-4bbd-91bd-22add93a92d8
[hero-image]: docs/media/board.png
