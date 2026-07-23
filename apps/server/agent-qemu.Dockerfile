# Last Light agent image + QEMU, so the gondolin micro-VM sandbox backend works
# in a container/Kubernetes environment. The base ghcr.io/nearform/lastlight-agent
# image ships no QEMU binary — it targets the `docker` backend; gondolin's QEMU
# is otherwise only provided on the native systemd host (deploy/native/). Built
# in the same bake graph as `agent` (docker-bake.hcl) via a content-keyed
# context, so it re-uses the base's layers and cache. See nearform/lastlight#210.
ARG AGENT_IMAGE=lastlight-agent:latest
FROM ${AGENT_IMAGE}
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils \
 && rm -rf /var/lib/apt/lists/*
# No USER / ENTRYPOINT / CMD — inherited from the base image (its entrypoint runs
# as root then `exec gosu lastlight`, UID 10001), so we must NOT set USER here.
