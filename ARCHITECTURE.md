# Architecture

iirc is a pure IRC client inside an Effect application shaped as ports and adapters. This is how the pieces fit together, why, and where to add to them.

## The shape

- **The IRC client is a pure value.** It takes inputs, and gives back its next state, its outputs, and News. It has no ports, no Effect, no clock, no storage, and no sockets.
- **The Daemon around it is an Effect application.** A Runtime drives one Client per Network. Its ports name the jobs the Daemon needs done: reach an Ircd, keep the Journal, hold Credentials, and tell the time. Layers supply the adapters.
- **History is the Journal.** It records every input and output in order, and everything else, including the Client's state, its timers, and News, is a projection of it.
- **IRCv3 enters through Features at the edges.** A Feature refines what the core derived from a Line, so the model never asks whether a cap is on.
- **The RFC protocol is the floor.** Any RFC Ircd gets at least base support, and nothing core depends on a cap.

```mermaid
flowchart LR
  subgraph driving["Driving side"]
    web["Web frontend"]
    agent["Scripts and agents"]
    cli["iirc CLI"]
  end

  subgraph hexagon["Daemon: the Effect application"]
    api["API<br/>HttpApi contract"]
    runtime["Runtime<br/>one driver per Network"]
    client["Client<br/>pure IRC core"]
    outbox["Outbox<br/>pacing per Connection"]
    projector["Projector<br/>folds News into Timelines"]
    api -->|"commands and reads"| runtime
    runtime <-->|"step: input to state, outputs, News"| client
    runtime --> outbox
    runtime -->|"News"| projector
  end

  subgraph driven["Driven side"]
    transport["Transport port"]
    journal["Journal port"]
    vault["Vault port"]
    clock["Clock port"]
    timelines["Timeline store port"]
  end

  web & agent & cli --> api
  runtime --> transport & journal & vault & clock
  projector --> timelines
  api -->|"Timeline reads"| timelines
  transport --- ircd[("Ircds")]
  journal --- sqlite[("journal.sqlite")]
  vault --- store[("credentials.json")]
  timelines --- views[("views.sqlite")]
```

| Port | Its job | Production adapter | Test adapter |
| --- | --- | --- | --- |
| API (driving) | Take the Owner's commands and answer reads | `HttpApi` on Bun, in `@iirc/daemon` | the same handlers through an in-process client |
| Transport | Dial an Ircd, carry Lines both ways, and say how the Connection ended | `@iirc/transport-bun`: TCP and TLS | the memory Transport in `@iirc/runtime/testing` |
| Journal | Append durably, read back, and follow the tail | `@iirc/journal-sqlite` | the memory Journal |
| Vault | Hold Credentials, and give a value at the last moment | `@iirc/vault-file` | the memory Vault |
| Clock | Tell the time, and wait until a time | Effect's `Clock` | Effect's `TestClock` |
| Timeline store | Keep the Timelines folded from News, and answer windows, changes, and searches | `@iirc/timeline-store-sqlite` | the memory store in `@iirc/timeline-store/testing` |

Ports are named for the job, not the technology behind them. Each port has laws that every adapter of it must pass, so a new adapter proves itself against the same tests as the fake: the Runtime's in `@iirc/runtime/testing`, and the Timeline store's in `@iirc/timeline-store/testing`.

## Packages

```mermaid
flowchart TB
  protocol["@iirc/protocol<br/>Lines, ISUPPORT, casemapping,<br/>CTCP, formatting"]
  client["@iirc/client<br/>machines, Features, Knowledge"]
  outbox["@iirc/outbox<br/>pacing"]
  timelines["@iirc/timelines<br/>Timelines folded from News"]
  store["@iirc/timeline-store<br/>the Timeline store port"]
  runtime["@iirc/runtime<br/>the ports, drives Clients"]
  api["@iirc/api<br/>HttpApi contract"]
  daemon["@iirc/daemon<br/>composition root"]
  app["apps/iirc<br/>the executable"]
  frontend["@iirc/frontend<br/>the web frontend's pure core"]
  web["apps/web<br/>the web frontend"]

  subgraph adapters["Adapters"]
    tbun["transport-bun"]
    jsql["journal-sqlite"]
    vfile["vault-file"]
    tsql["timeline-store-sqlite"]
  end

  client --> protocol
  runtime --> client & outbox
  timelines --> client
  store --> timelines
  tbun & jsql & vfile --> runtime
  tsql --> store
  api --> client & timelines
  daemon --> api & runtime & store & adapters
  app --> daemon
  frontend --> protocol & timelines
  frontend -.->|"the Configuration's Schema"| client
  frontend -.->|"types, and the ui options' Schema"| api
  web --> api & frontend
  app -.->|"serves its build"| web
```

- **SASL `SCRAM-SHA-256` and `EXTERNAL`.** SCRAM's replies depend on the Ircd's challenge, so it lands in `SecretLine` or on the Runtime's side. EXTERNAL logs in with a client certificate, which `Dial` would name as a Credential.
- **`message-redaction` and `channel-rename`.** A redaction points at an earlier message id, which fits an append-only Journal. A rename means a Timeline cannot be keyed by a Channel's name, so both matter before Views choose their keys.
- **`TAGMSG` and client tags such as `typing`.** `typing` can arrive every 3 seconds per Target, and every received Line is journaled, so decide how the Journal holds it before turning it on.
