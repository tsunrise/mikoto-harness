---
name: <operation-specific-name-with-no-mikoto-branding>
description: <Describe what the capability does and exactly when to use it.>
---

# <Capability title>

<Briefly describe what the capability lets an `exec_command` workload do, name
its authenticated route, and summarize its intended use.>

## Precondition

Use this skill only when at least one of these conditions applies:

- <First intended trigger.>
- <Another intended trigger, if applicable.>

<Describe cases that do not qualify, actions that would be redundant, and
other operation-specific limits on when the capability should be invoked.>

## Capability API

The capability server endpoint is provided in the `GARDEN_SERVER` environment
variable and authenticated with the bearer token in the `GARDEN_TOKEN`
environment variable. The built-in proxy is enabled automatically through
environment variables for curl, Python, and Node.js, so no manual proxy
configuration is needed.

### `<METHOD> /<route>`

<Describe the operation performed by this endpoint.>

- **Headers:** <List expected request headers and their values.>
- **Body:** <Describe the request body, encoding, schema, size limits, and
  sensitive data restrictions. Write `None.` for a request without a body.>
- **Response:** <Document success and expected failure statuses, response
  bodies, and whether a successful response confirms completion or only
  acceptance.>

```sh
curl --disable --silent --show-error --fail --max-time 65 \
  --header "Authorization: Bearer $GARDEN_TOKEN" \
  <add any content-type header and request body options required by the endpoint> \
  "$GARDEN_SERVER/<route>"
```
