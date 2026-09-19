# Collider 제출용 설명

## 한국어

### 한 줄 설명

각각은 정상인 Pull Request들이 함께 merge될 때 생기는 행동 충돌을, 실제 merge 전에 찾아주는 도구입니다.

### 설명

개발자가 코드를 수정하면 바로 서비스에 반영하지 않습니다. 먼저 Pull Request, 줄여서 PR을 올리고 리뷰와 자동 검사를 거칩니다. PR이 merge되면 그 변경이 모두가 함께 쓰는 main 코드에 들어갑니다.

문제는 여러 PR이 동시에 만들어질 때 생깁니다. PR A도 통과하고 PR B도 통과했지만, 둘을 함께 merge했을 때만 기능이 깨질 수 있습니다. 특히 Claude Code나 Codex 같은 코딩 에이전트 덕분에 동시에 진행되는 작업과 PR 수가 늘면서 이런 상호작용을 사람이 모두 확인하기가 더 어려워졌습니다.

Collider는 여러 PR을 Daytona 샌드박스에서 실제로 merge하고 기존 테스트를 실행합니다. 기존 테스트가 모두 통과하면 Nosana에서 실행되는 qwen3.5:9b가 PR diff와 프로젝트 명세를 읽어 빠져 있는 상호작용 테스트를 만듭니다. 그 테스트도 Daytona에서 실제로 실행해서 결과를 확인합니다.

데모에서는 쿠폰 할인 PR과 멤버십 할인 PR이 각각 독립적으로는 정상이고 기존 테스트도 모두 통과하지만, 함께 merge하면 8,000원이 되어야 할 금액이 8,100원으로 계산되는 문제를 찾습니다.

웹에서는 누구나 PR URL을 직접 넣어서 검사할 수 있습니다. 팀에서는 같은 분석을 GitHub CI에 연결해 PR이 열리거나 업데이트될 때 자동으로 실행하고, 결과를 PR comment와 check로 받을 수 있습니다.

### 기존 도구와 다른 점

일반적인 코드 리뷰는 한 PR 안의 변경을 봅니다. GitHub Merge Queue는 여러 PR을 합친 뒤 이미 존재하는 테스트를 실행합니다.

Collider는 여러 PR 사이의 상호작용을 보고, 레포에 없는 테스트가 필요하면 새로 만든 뒤 실제 코드에서 실행합니다.

---

## English

### One-line description

Collider finds behavioral collisions that appear only when individually green pull requests are merged together.

### Description

A developer normally does not send a code change straight to production. They first open a Pull Request, or PR, asking to merge that change into the shared codebase. After review and automated checks pass, the PR is merged into the main branch.

The problem appears when several PRs are being built at the same time. PR A can pass on its own. PR B can pass on its own. The combination can still break. As coding agents such as Claude Code and Codex increase the number of changes teams can produce in parallel, it becomes harder for people to reason about every interaction between those changes.

Collider builds those combined states before they reach main. It merges PR combinations inside a Daytona sandbox and runs the existing test suite. If the existing tests still pass, qwen3.5:9b running on Nosana reads the PR diffs and project specification, then creates a missing interaction test. Collider runs that test inside Daytona as well.

In the demo, a coupon PR and a membership-discount PR both pass independently. The repository's existing tests also pass after both are merged. But when the two features are used together, the correct price is 8,000 while the combined code returns 8,100. Collider finds that regression before the changes reach main.

Anyone can paste PR URLs into the public web app and run a manual check. Teams can attach the same analysis to GitHub CI so Collider runs automatically when a PR is opened or updated, then posts the result back to the PR as a check and comment.

### How it differs

A code review usually evaluates one change at a time. GitHub Merge Queue can combine changes, but it runs the tests that already exist.

Collider looks at the interaction between changes. When the needed interaction test does not exist, it creates one and executes it against the combined code.
