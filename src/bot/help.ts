import * as fs from 'fs';
import * as path from 'path';

// Read version from package.json
let botVersion = "Unknown";
try {
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');
  const packageData = fs.readFileSync(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(packageData);
  botVersion = packageJson.version || "Unknown";
} catch (e) {
  console.error("Could not read package.json version:", e);
}

export const HELP_TEXT = `🤖 **Photo Monitor Bot (Версия: ${botVersion})**

**Доступные команды:**
/add_keyword <слово> - Добавить ключевое слово для мониторинга.
/add_keyword <слово1>, <слово2> - Добавить правило "И" (сообщение должно содержать ОБА слова).
/list_keywords - Показать список ключевых слов и правил.
/add_source <ID_группы> - Добавить группу для мониторинга.
/list_sources - Показать список групп.
/set_target <ID_канала> - Установить канал для уведомлений.
/stats - Показать статистику за последние 24 часа.
/help - Показать это сообщение.

**Как работают ключевые слова (Правила):**
1. **Одно слово:** \`/add_keyword ретушь\`
   Бот пришлет уведомление, если в тексте есть слово "ретушь".
2. **Несколько слов (Логика "И"):** \`/add_keyword ищу, фотографа\`
   Бот пришлет уведомление ТОЛЬКО если в тексте есть И слово "ищу", И слово "фотографа" (в любом порядке).
   *Пример срабатывания:* "Срочно ищу хорошего фотографа на завтра."
   *Пример игнора:* "Ищу модель для съемки." (нет слова "фотографа").

**Важно:** Слова разделяются запятой. Пробелы вокруг запятой игнорируются. Регистр букв не имеет значения.`;

