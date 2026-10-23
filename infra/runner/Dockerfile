FROM eclipse-temurin@sha256:742daacb9316be4b6fc60258f6e4ac2a11882f6c597373c92290a57bfad0d2e0
# Trusted controller requires a Docker CLI, installed from the pinned Docker CE package.
# The host socket is available to this service exclusively; never to API or sandboxes.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu jammy stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y --no-install-recommends docker-ce-cli=5:29.9.2-1~ubuntu.22.04~jammy && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/runner-controller/target/runner-controller-0.1.0-SNAPSHOT.jar /app/runner-controller.jar
ENV JB_RUNNER_PORT=8091 JB_RUNNER_BIND=0.0.0.0
ENTRYPOINT ["java","-Xmx256m","-jar","/app/runner-controller.jar"]
