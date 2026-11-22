# `observability` — credits

[`SKILL.md`](SKILL.md) is distilled from **Boris Tane**'s [*Logging
Sucks*](https://loggingsucks.com/) — the phrasing is mine, the ideas are his: the
wide event (a term he credits to
[Stripe](https://stripe.com/blog/canonical-log-lines)) as one context-rich record
per unit of work, cardinality and dimensionality as what makes a row queryable,
OpenTelemetry as delivery that decides nothing about content, the event and the
span being the same record, and tail sampling. Deeper background in his [wide
events 101](https://boristane.com/blog/observability-wide-events-101/); he also
publishes an agent-facing distillation at
[boristane/agent-skills](https://github.com/boristane/agent-skills) (no license
stated). The rest — the code snippets and the checks — is what the argument
turned into in my own services.

This skill owns logging, tracing, metrics and OTel guidance. `quality-code` stays
the source of truth for type safety, tests and abstraction choice.
