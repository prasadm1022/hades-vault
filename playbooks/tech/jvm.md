# JVM (Java, Kotlin, Scala)

## Detect
- Maven: `pom.xml` (+ `mvnw`, `.mvn/`). Gradle: `build.gradle(.kts)`, `settings.gradle(.kts)`, `gradlew`,
  `gradle/libs.versions.toml`. sbt: `build.sbt`, `project/build.properties`.
- JDK version: toolchain block, `maven.compiler.release`/`<java.version>`, `.java-version`, `.sdkmanrc`.
- Frameworks: `spring-boot-starter-*` (Spring Boot), `io.quarkus`, `io.micronaut`, `ktor`, Play, Akka/Pekko.
- Kotlin: `kotlin("jvm")` plugin or `*.kt`; Android projects: `mobile.md`.

## Commands (always the wrapper; on cmd/PowerShell `mvnw.cmd` / `gradlew.bat`)
| key | Maven | Gradle | sbt |
|---|---|---|---|
| install | `./mvnw -B -ntp -q dependency:go-offline` (optional) | n/a (build resolves) | `sbt -batch update` |
| build | `./mvnw -B -ntp -q package -DskipTests` | `./gradlew assemble --console=plain -q` | `sbt -batch compile` |
| lint | `./mvnw -B -ntp checkstyle:check` / `spotless:check` (only if configured) | `./gradlew spotlessCheck` / `ktlintCheck` / `detekt` (if configured) | `sbt -batch scalafmtCheckAll` |
| types | n/a (compilation) | n/a | n/a |
| test | `./mvnw -B -ntp test` (integration: `verify`) | `./gradlew test --console=plain` (all checks: `check`) | `sbt -batch test` |
| run | `./mvnw spring-boot:run` | `./gradlew bootRun` / `run` | `sbt run` (background only) |
| format | `./mvnw spotless:check` | `./gradlew spotlessCheck` | `sbt -batch scalafmtCheckAll` |

Single test: `./mvnw -B -ntp test -Dtest=OrderServiceTest#create` (multi-module: `-pl <module> -am
-Dsurefire.failIfNoSpecifiedTests=false`); `./gradlew :<module>:test --tests 'com.acme.OrderServiceTest'`;
`sbt -batch "testOnly com.acme.OrderSpec"`.

## Layout
`src/main/{java,kotlin,scala,resources}`, `src/test/...` mirroring packages. Multi-module: one module per
layer or bounded context; parent pom / `settings.gradle` lists modules. Spring: `controller` ->
`service` -> `repository`, DTOs separate from entities, config in `application.yml` + profiles,
migrations in `src/main/resources/db/migration` (Flyway) or `db/changelog` (Liquibase), see `databases.md`.

## Testing
- JUnit 5, AssertJ, Mockito (Kotlin: MockK), ScalaTest/MUnit. Surefire runs `*Test`, Failsafe `*IT` on `verify`.
- Spring slices: `@WebMvcTest`, `@DataJpaTest`, `@SpringBootTest` + `MockMvc`/`WebTestClient` for full stack.
- Real dependencies: Testcontainers (needs Docker running). Coverage: JaCoCo report in `target/site/jacoco`
  or `build/reports/jacoco`.
- API e2e: REST Assured or Playwright API tests (`../qa-automation.md`).

## Security
- trivy reads `pom.xml` (resolves from Maven Central) and `gradle.lockfile`; Gradle builds without
  dependency locking are invisible to it, so scan the built jars:
  `hades tools run trivy -- rootfs --scanners vuln --severity HIGH,CRITICAL build/libs`.
- OWASP dependency-check is slow and needs an NVD API key: use only if the project already does.
- Review: string-built JPQL/SQL, `@CrossOrigin("*")`, exposed actuator endpoints (`management.endpoints.web.exposure`),
  Jackson default typing, XML parsers without XXE protection, `permitAll()` scope in Spring Security.

## Pitfalls
- First build downloads hundreds of MB: background + long timeout; later builds use `~/.m2` / `~/.gradle`.
- `-B` (batch) stops Maven prompts and colour; `-ntp` hides download progress. Gradle: `--console=plain`.
- Gradle daemon speeds repeated gates but survives the command and locks files on Windows: `./gradlew --stop`
  before deleting `build/` or switching JDKs.
- `gradlew` without the execute bit (checked out on Windows): run `sh gradlew <task>`.
- `JAVA_HOME` must point to the JDK the build asks for; a newer JDK can break Lombok, Kotlin or Gradle.
- `-DskipTests` compiles tests, `-Dmaven.test.skip=true` does not: use the first in build steps.
- Never `mvn deploy`/`gradle publish` (publishes artefacts); `install` writes only to the local `~/.m2`.

## Small output
`-q` on Maven and Gradle prints errors only; failures: `target/surefire-reports/*.txt`,
`build/reports/tests/test/index.html` or `build/test-results/test/*.xml` (grep `<failure`).
