export type TourStep = {
  id: string;
  target: string;
  title: string;
  text: string;
  action: "click" | "focus" | "input" | "download" | "inspect" | "wait";
  waitFor?: "comparison" | "run";
  afterJobId?: string;
  actionTarget?: string;
  panel?:
    "project" | "graph" | "palette" | "code" | "tests" | "analysis" | "console";
};
export const homeSteps: TourStep[] = [
  {
    id: "open-project",
    target: ".project-row, .sample-row",
    title: "Откройте проект",
    text: "Нажмите на проект. Если своих проектов ещё нет, начните с готового примера.",
    action: "click",
  },
];
export const workspaceSteps: TourStep[] = [
  {
    id: "file",
    target: "[data-file-path]:not([data-directory-path])",
    panel: "project",
    title: "Выберите файл",
    text: "Нажмите на файл в дереве. На полотне появятся схемы его методов, а в редакторе — исходный код.",
    action: "click",
  },
  {
    id: "method",
    target: ".method-item",
    panel: "project",
    title: "Откройте метод",
    text: "Нажмите на название метода под файлом, чтобы рассмотреть его отдельно.",
    action: "click",
  },
  {
    id: "node",
    target:
      '.blueprint-node[data-node-kind="ExpressionStmt"], .blueprint-node[data-node-kind="ReturnStmt"], .blueprint-node[data-node-kind="IfStmt"], .blueprint-node',
    panel: "graph",
    title: "Выберите блок",
    text: "Нажмите на блок. Справа появятся его исходный код, связи и доступные действия.",
    action: "click",
  },
  {
    id: "download",
    target: ".file-tabs",
    panel: "code",
    title: "Скачайте текущий файл",
    text: "Нажмите Ctrl+S или ⌘S. Скачается выбранный файл с текущим текстом. Кнопка «Сохранить» отдельно сохраняет изменения в проекте.",
    action: "download",
  },
  {
    id: "template",
    target: ".palette-condition",
    panel: "palette",
    title: "Попробуйте шаблон условия",
    text: "Нажмите «Условие». Для выбранного блока с точкой вставки откроется шаблон и предварительный вид схемы. Также шаблоны можно перетаскивать.",
    action: "click",
  },
  {
    id: "preview",
    target: ".expression-form, .inspector-selection",
    panel: "analysis",
    title: "Сначала — просмотр изменений",
    text: "Поля относятся к выбранному блоку. Подготовка показывает разницу, а применение меняет исходник только после необходимых проверок. Пока ничего применять не нужно.",
    action: "inspect",
  },
  {
    id: "run",
    target: ".dock-run:not(:disabled)",
    title: "Откройте запуск",
    text: "Нажмите «Запуск». Сначала откроются параметры — программа ещё не будет выполняться.",
    action: "click",
  },
  {
    id: "run-options",
    target: 'button[aria-label="Закрыть диалог"]',
    title: "Параметры запуска",
    text: "Здесь выбираются класс с main, аргументы и ввод. Во время выполнения ответы отправляются через консоль. Сейчас закройте окно крестиком.",
    action: "click",
  },
  {
    id: "compare",
    target: 'button[aria-label="Сравнить"]:not(:disabled)',
    title: "Откройте сравнение",
    text: "Нажмите кнопку сравнения. Она проверяет две версии на одних и тех же наборах входных данных.",
    action: "click",
  },
  {
    id: "compare-options",
    target: 'button[aria-label="Закрыть диалог"]',
    title: "Проверка перед применением",
    text: "В этом окне выбираются версии и тесты. Статусы и время появятся в панели тестов. Сейчас закройте окно, не начиная проверку.",
    action: "click",
  },
  {
    id: "view",
    target: '[data-tour="workspace-view"]',
    title: "Настройте рабочее место",
    text: "Откройте «Вид». Здесь можно скрывать панели, сохранять раскладку и возвращать навигацию наверх.",
    action: "click",
  },
  {
    id: "layout",
    target: '[data-tour="save-layout"]',
    title: "Сохраните расположение",
    text: "Нажмите эту команду, чтобы запомнить текущую раскладку для проекта. Для новых проектов можно отдельно сохранить базовое расположение.",
    action: "click",
  },
];
export const accountSteps: TourStep[] = [
  {
    id: "settings",
    target:
      '.local-presence, .account-nav a[href="/settings/profile"], .product-sidebar a[href="/settings/profile"]',
    title: "Перейдите к настройкам",
    text: "Нажмите на аккаунт в редакторе или «Настройки» в верхней панели.",
    action: "click",
  },
  {
    id: "name",
    target: '[data-tour="profile-name"]',
    title: "Отображаемое имя",
    text: "Нажмите на поле имени. Оно изменяет подпись в профиле; username остаётся отдельным идентификатором. Вводить или сохранять новое имя для обучения не обязательно.",
    action: "focus",
  },
  {
    id: "photo",
    target: '[data-tour="profile-photo"]',
    title: "Фото профиля",
    text: "Здесь можно загрузить, заменить или удалить фото. Подходят PNG и JPEG до 2 МБ.",
    action: "inspect",
  },
  {
    id: "public-profile",
    target: '.account-nav a[href^="/u/"]',
    title: "Посмотрите свой профиль",
    text: "Нажмите на свой аккаунт. Откроется профиль с проектами и активностью, доступными посетителю по его правам.",
    action: "click",
  },
  {
    id: "edit-profile",
    target: '.profile-summary a[href="/settings/profile"]',
    title: "Вернитесь к редактированию",
    text: "Кнопка «Редактировать профиль» возвращает к настройкам имени, фото и описания. Нажмите её.",
    action: "click",
  },
  {
    id: "security",
    target: '.product-sidebar a[href="/settings/security"]',
    title: "Откройте безопасность",
    text: "Перейдите в раздел безопасности.",
    action: "click",
  },
  {
    id: "security-method",
    target: "#security .setting-row",
    title: "Способ входа",
    text: "Здесь показан способ входа в аккаунт. Для аккаунтов с паролем доступны его смена и подтверждение почты; для GitHub — вход через GitHub. Никакие письма или изменения обучение само не отправляет.",
    action: "inspect",
  },
  {
    id: "appearance",
    target: '.product-sidebar a[href="/settings/appearance"]',
    title: "Откройте оформление",
    text: "Перейдите к цветам и темам интерфейса.",
    action: "click",
  },
  {
    id: "theme",
    target: ".theme-options",
    actionTarget: ".theme-option",
    title: "Выберите тему",
    text: "Нажмите на любую тему. OLED использует чистый чёрный фон. Выбор сохраняется в этом браузере.",
    action: "click",
  },
  {
    id: "palette",
    target: ".custom-colors",
    title: "Собственная палитра",
    text: "Цвета справа отвечают за фон, поверхности, текст и акцент. Нажмите на образец для выбора цвета, затем примените палитру. Менять её для продолжения необязательно.",
    action: "inspect",
  },
  {
    id: "friends",
    target: '.product-sidebar a[href="/settings/friends"]',
    title: "Откройте друзей",
    text: "Здесь находятся поиск людей и заявки в друзья.",
    action: "click",
  },
  {
    id: "people",
    target: '.people-search input[aria-label="Поиск пользователей"]',
    title: "Попробуйте поиск",
    text: "Введите хотя бы два символа имени пользователя. Кнопка «Найти» покажет совпадения; заявка отправляется только отдельной кнопкой.",
    action: "input",
  },
  {
    id: "integrations",
    target: '.product-sidebar a[href="/settings/integrations"]',
    title: "Откройте интеграции",
    text: "Перейдите к подключениям внешних сервисов.",
    action: "click",
  },
  {
    id: "github",
    target: ".github-settings .integration-controls",
    title: "GitHub и импорт",
    text: "После подключения GitHub можно выбирать репозиторий, ветку, папки и отдельные файлы при импорте. Обучение не подключает аккаунт автоматически. Его всегда можно повторить кнопкой «Обучение» слева или через «Справку» в редакторе.",
    action: "inspect",
  },
];
export type TourMode = "full" | "workspace" | "account";
export const tourSteps = (mode: TourMode) =>
  mode === "workspace"
    ? workspaceSteps
    : mode === "account"
      ? accountSteps
      : [...homeSteps, ...workspaceSteps, ...accountSteps];
