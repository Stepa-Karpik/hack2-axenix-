FROM eclipse-temurin@sha256:742daacb9316be4b6fc60258f6e4ac2a11882f6c597373c92290a57bfad0d2e0
WORKDIR /app
COPY apps/server/target/server-0.1.0-SNAPSHOT.jar /app/server.jar
COPY apps/web/dist/ /app/public/
USER 65534:65534
ENV JB_BIND_HOST=0.0.0.0 JB_API_PORT=8081 SPRING_WEB_RESOURCES_STATIC_LOCATIONS=file:/app/public/
ENTRYPOINT ["java","-Xmx512m","-jar","/app/server.jar"]
