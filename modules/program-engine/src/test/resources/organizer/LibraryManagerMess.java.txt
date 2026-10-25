import java.util.ArrayList;
import java.util.Collections;
import java.util.ConcurrentModificationException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Scanner;
import java.util.Set;
import java.util.TreeMap;
import java.util.InputMismatchException;

/**
 * Тестовая программа №3: учёт книг в библиотеке.
 */
public class LibraryManagerMess {

    // ------------------------------------------------------------------
    // Иерархия исключений
    // ------------------------------------------------------------------

    static class LibraryException extends Exception {
        public LibraryException(String message) {
            super(message);
        }

        public LibraryException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    static class BookNotFoundException extends LibraryException {
        public BookNotFoundException(String bookId) {
            super("Книга не найдена: " + bookId);
        }
    }

    static class NoCopiesLeftException extends LibraryException {
        public NoCopiesLeftException(String title) {
            super("Нет свободных экземпляров: " + title);
        }
    }

    static class MemberBannedException extends RuntimeException {
        public MemberBannedException(String member) {
            super("Участник заблокирован: " + member);
        }
    }

    static class LimitExceededException extends RuntimeException {
        public LimitExceededException(String member, int limit) {
            super("Превышен лимит " + limit + " книг у участника " + member);
        }
    }

    // ------------------------------------------------------------------
    // Глобальное состояние
    // ------------------------------------------------------------------

    static Map<String, String> bookTitles = new HashMap<>();
    static Map<String, String> bookAuthors = new HashMap<>();
    static Map<String, Integer> bookYears = new HashMap<>();
    static Map<String, Integer> bookCopies = new HashMap<>();
    static Map<String, Integer> bookTotalCopies = new HashMap<>();

    static List<String> memberNames = new ArrayList<>();
    static List<Integer> memberFines = new ArrayList<>();
    static Map<String, List<String>> memberLoans = new HashMap<>();
    static Set<String> bannedMembers = new HashSet<>();

    static List<String> eventLog = new ArrayList<>();
    static Map<String, Integer> errorStats = new TreeMap<>();
    static int commandsProcessed = 0;
    static int linearSteps = 0;
    static final int MAX_LOANS = 3;
    static final int FINE_PER_DAY = 5;
    static final int BAN_THRESHOLD = 100;

    static String[] SCRIPT = {
        "addbook B001 Dune Frank_Herbert 1965 3",
        "addbook B002 Neuromancer William_Gibson 1984 2",
        "addbook B003 Foundation Isaac_Asimov 1951 2",
        "addbook B004 I_Robot Isaac_Asimov 1950 1",
        "addbook B005 Solaris Stanislaw_Lem 1961 2",
        "addbook B006 Hyperion Dan_Simmons 1989 1",
        "addbook B001 Dune_Again Frank_Herbert 1965 1",
        "member alice",
        "member bob",
        "member carol",
        "member dave",
        "member alice",
        "borrow alice B001",
        "borrow alice B002",
        "borrow alice B003",
        "borrow alice B004",
        "borrow bob B004",
        "borrow bob B004",
        "borrow bob B999",
        "borrow carol B006",
        "borrow dave B006",
        "borrow eve B001",
        "return alice B001 2",
        "return alice B002 30",
        "return bob B004 25",
        "return carol B006 0",
        "return carol B006 0",
        "fine bob 40",
        "fine dave abc",
        "borrow bob B005",
        "search Du",
        "search so",
        "author Isaac_Asimov",
        "author Nobody",
        "ban dave",
        "borrow dave B005",
        "return",
        "report",
        "audit",
        "unknowncommand"
    };

    // ------------------------------------------------------------------
    // Вспомогательные функции
    // ------------------------------------------------------------------

    static String lower(String s) {
        String result = "";
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 'A' && c <= 'Z') {
                c = (char) (c + 32);
            }
            result = result + c;
        }
        return result;
    }

    static String underscoresToSpaces(String s) {
        String result = "";
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) == '_') {
                result = result + " ";
            } else {
                result = result + s.charAt(i);
            }
        }
        return result;
    }

    static List<String> tokenize(String line) {
        List<String> tokens = new ArrayList<>();
        String current = "";
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == ' ') {
                if (current.length() > 0) {
                    tokens.add(current);
                    current = "";
                }
            } else {
                current = current + c;
            }
        }
        if (current.length() > 0) {
            tokens.add(current);
        }
        return tokens;
    }

    static boolean startsWithIgnoreCase(String text, String prefix) {
        if (prefix.length() > text.length()) {
            return false;
        }
        String a = lower(text);
        String b = lower(prefix);
        for (int i = 0; i < b.length(); i++) {
            if (a.charAt(i) != b.charAt(i)) {
                return false;
            }
        }
        return true;
    }

    static boolean containsIgnoreCase(String text, String part) {
        String a = lower(text);
        String b = lower(part);
        for (int i = 0; i + b.length() <= a.length(); i++) {
            if (a.substring(i, i + b.length()).equals(b)) {
                return true;
            }
        }
        return false;
    }

    static void logEvent(String event) {
        eventLog.add(event);
    }

    static void countError(String kind) {
        if (errorStats.containsKey(kind)) {
            errorStats.put(kind, errorStats.get(kind) + 1);
        } else {
            errorStats.put(kind, 1);
        }
    }

    // ------------------------------------------------------------------
    // Книги
    // ------------------------------------------------------------------

    static void addBook(String id, String title, String author, int year, int copies) throws LibraryException {
        if (bookTitles.containsKey(id)) {
            throw new LibraryException("Книга уже существует: " + id);
        }
        if (copies <= 0) {
            throw new IllegalArgumentException("Число экземпляров должно быть положительным");
        }
        bookTitles.put(id, title);
        bookAuthors.put(id, author);
        bookYears.put(id, year);
        bookCopies.put(id, copies);
        bookTotalCopies.put(id, copies);
        logEvent("ADD " + id);
    }

    static String findBookIdByTitleSlow(String title) {
        for (String id : bookTitles.keySet()) {
            linearSteps++;
            if (bookTitles.get(id).equals(title)) {
                return id;
            }
        }
        return null;
    }

    static Optional<String> findBookIdOptional(String title) {
        String id = findBookIdByTitleSlow(title);
        if (id == null) {
            return Optional.empty();
        }
        return Optional.of(id);
    }

    static List<String> findBooksByAuthorSlow(String author) {
        List<String> result = new ArrayList<>();
        for (String id : bookAuthors.keySet()) {
            linearSteps++;
            if (bookAuthors.get(id).equals(author)) {
                result.add(id);
            }
        }
        Collections.sort(result);
        return result;
    }

    static List<String> searchByPrefix(String prefix) {
        List<String> found = new ArrayList<>();
        List<String> ids = new ArrayList<>(bookTitles.keySet());
        Collections.sort(ids);
        for (int i = 0; i < ids.size(); i++) {
            String title = underscoresToSpaces(bookTitles.get(ids.get(i)));
            if (startsWithIgnoreCase(title, prefix) || containsIgnoreCase(title, prefix)) {
                found.add(ids.get(i));
            }
            linearSteps++;
        }
        return found;
    }

    static List<String> booksSortedByTitleBubble() {
        List<String> ids = new ArrayList<>(bookTitles.keySet());
        for (int i = 0; i < ids.size(); i++) {
            for (int j = 0; j < ids.size() - 1; j++) {
                String t1 = bookTitles.get(ids.get(j));
                String t2 = bookTitles.get(ids.get(j + 1));
                if (t1.compareTo(t2) > 0) {
                    String tmp = ids.get(j);
                    ids.set(j, ids.get(j + 1));
                    ids.set(j + 1, tmp);
                }
                linearSteps++;
            }
        }
        return ids;
    }

    static int availableCopiesTotal() {
        int total = 0;
        for (String id : bookCopies.keySet()) {
            total = total + bookCopies.get(id);
        }
        return total;
    }

    static int totalCopiesAll() {
        int total = 0;
        for (String id : bookTotalCopies.keySet()) {
            total = total + bookTotalCopies.get(id);
        }
        return total;
    }

    static Map<String, Integer> copiesByAuthor() {
        Map<String, Integer> result = new TreeMap<>();
        for (String id : bookTotalCopies.keySet()) {
            String author = bookAuthors.get(id);
            int old = 0;
            if (result.containsKey(author)) {
                old = result.get(author);
            }
            result.put(author, old + bookTotalCopies.get(id));
        }
        return result;
    }

    static List<String> findDuplicateTitles() {
        List<String> duplicates = new ArrayList<>();
        List<String> ids = new ArrayList<>(bookTitles.keySet());
        for (int i = 0; i < ids.size(); i++) {
            for (int j = i + 1; j < ids.size(); j++) {
                if (Objects.equals(bookTitles.get(ids.get(i)), bookTitles.get(ids.get(j)))) {
                    duplicates.add(ids.get(i) + "=" + ids.get(j));
                }
            }
        }
        return duplicates;
    }

    static int oldestBookYear() {
        int oldest = Integer.MAX_VALUE;
        for (String id : bookYears.keySet()) {
            if (bookYears.get(id) < oldest) {
                oldest = bookYears.get(id);
            }
        }
        return oldest;
    }

    // ------------------------------------------------------------------
    // Участники
    // ------------------------------------------------------------------

    static int indexOfMember(String name) {
        for (int i = 0; i < memberNames.size(); i++) {
            linearSteps++;
            if (memberNames.get(i).equals(name)) {
                return i;
            }
        }
        return -1;
    }

    static void addMember(String name) throws LibraryException {
        if (indexOfMember(name) != -1) {
            throw new LibraryException("Участник уже существует: " + name);
        }
        memberNames.add(name);
        memberFines.add(0);
        memberLoans.put(name, new ArrayList<String>());
        logEvent("MEMBER " + name);
    }

    static void addFine(String name, int amount) throws LibraryException {
        int idx = indexOfMember(name);
        if (idx == -1) {
            throw new LibraryException("Нет участника: " + name);
        }
        int newFine = memberFines.get(idx) + amount;
        memberFines.set(idx, newFine);
        logEvent("FINE " + name + " " + amount);
        if (newFine > BAN_THRESHOLD) {
            bannedMembers.add(name);
            logEvent("BAN " + name);
        }
    }

    static void banMember(String name) throws LibraryException {
        if (indexOfMember(name) == -1) {
            throw new LibraryException("Нет участника: " + name);
        }
        bannedMembers.add(name);
        logEvent("BAN " + name);
    }

    static int totalFines() {
        int total = 0;
        for (int i = 0; i < memberFines.size(); i++) {
            total = total + memberFines.get(i);
        }
        return total;
    }

    static int totalLoansNow() {
        int total = 0;
        for (int i = 0; i < memberNames.size(); i++) {
            total = total + memberLoans.get(memberNames.get(i)).size();
        }
        return total;
    }

    static String richestDebtor() {
        int best = -1;
        String bestName = "-";
        for (int i = 0; i < memberNames.size(); i++) {
            if (memberFines.get(i) > best) {
                best = memberFines.get(i);
                bestName = memberNames.get(i);
            }
        }
        return bestName;
    }

    // ------------------------------------------------------------------
    // Выдача и возврат
    // ------------------------------------------------------------------

    static void borrowBook(String member, String bookId) throws LibraryException {
        int idx = indexOfMember(member);
        if (idx == -1) {
            throw new LibraryException("Нет участника: " + member);
        }
        if (bannedMembers.contains(member)) {
            throw new MemberBannedException(member);
        }
        if (!bookTitles.containsKey(bookId)) {
            throw new BookNotFoundException(bookId);
        }
        List<String> loans = memberLoans.get(member);
        if (loans.size() >= MAX_LOANS) {
            throw new LimitExceededException(member, MAX_LOANS);
        }
        for (int i = 0; i < loans.size(); i++) {
            if (loans.get(i).equals(bookId)) {
                throw new LibraryException("Книга уже у участника: " + bookId);
            }
        }
        int copies = bookCopies.get(bookId);
        if (copies == 0) {
            throw new NoCopiesLeftException(underscoresToSpaces(bookTitles.get(bookId)));
        }
        bookCopies.put(bookId, copies - 1);
        loans.add(bookId);
        logEvent("BORROW " + member + " " + bookId);
    }

    static void returnBook(String member, String bookId, int daysLate) throws LibraryException {
        int idx = indexOfMember(member);
        if (idx == -1) {
            throw new LibraryException("Нет участника: " + member);
        }
        List<String> loans = memberLoans.get(member);
        boolean removed = false;
        Iterator<String> it = loans.iterator();
        while (it.hasNext()) {
            String current = it.next();
            if (current.equals(bookId)) {
                it.remove();
                removed = true;
            }
        }
        if (!removed) {
            throw new LibraryException("У участника нет книги " + bookId);
        }
        bookCopies.put(bookId, bookCopies.get(bookId) + 1);
        logEvent("RETURN " + member + " " + bookId);
        if (daysLate > 0) {
            addFine(member, daysLate * FINE_PER_DAY);
        }
    }

    // ------------------------------------------------------------------
    // Разбор и выполнение команд
    // ------------------------------------------------------------------

    static void execute(String line) throws LibraryException {
        List<String> t = tokenize(line);
        String command = t.get(0);
        if (command.equals("addbook")) {
            addBook(t.get(1), t.get(2), t.get(3), Integer.parseInt(t.get(4)), Integer.parseInt(t.get(5)));
        } else if (command.equals("member")) {
            addMember(t.get(1));
        } else if (command.equals("borrow")) {
            borrowBook(t.get(1), t.get(2));
        } else if (command.equals("return")) {
            returnBook(t.get(1), t.get(2), Integer.parseInt(t.get(3)));
        } else if (command.equals("fine")) {
            addFine(t.get(1), Integer.parseInt(t.get(2)));
        } else if (command.equals("ban")) {
            banMember(t.get(1));
        } else if (command.equals("search")) {
            List<String> found = searchByPrefix(t.get(1));
            System.out.println("  Поиск '" + t.get(1) + "': " + found);
        } else if (command.equals("author")) {
            List<String> found = findBooksByAuthorSlow(t.get(1));
            if (found.isEmpty()) {
                throw new LibraryException("Автор не найден: " + t.get(1));
            }
            System.out.println("  Книги автора " + underscoresToSpaces(t.get(1)) + ": " + found);
        } else if (command.equals("report")) {
            printReport();
        } else if (command.equals("audit")) {
            runAudit();
        } else {
            throw new UnsupportedOperationException("Неизвестная команда: " + command);
        }
    }

    static void processScript(String[] script) {
        for (int i = 0; i < script.length; i++) {
            String line = script[i];
            try {
                execute(line);
            } catch (BookNotFoundException e) {
                countError("BookNotFound");
                System.out.println("  [!] " + e.getMessage());
            } catch (NoCopiesLeftException e) {
                countError("NoCopies");
                System.out.println("  [!] " + e.getMessage());
            } catch (LibraryException e) {
                countError("Library");
                System.out.println("  [!] " + e.getMessage());
            } catch (MemberBannedException | LimitExceededException e) {
                countError("Rules");
                System.out.println("  [!] " + e.getMessage());
            } catch (NumberFormatException e) {
                countError("Number");
                System.out.println("  [!] Некорректное число в команде '" + line + "'");
            } catch (IndexOutOfBoundsException e) {
                countError("Arguments");
                System.out.println("  [!] Не хватает аргументов в команде '" + line + "'");
            } catch (RuntimeException e) {
                countError("Runtime");
                System.out.println("  [!] " + e.getClass().getSimpleName() + ": " + e.getMessage());
            } finally {
                commandsProcessed++;
            }
        }
    }

    // ------------------------------------------------------------------
    // Отчёты и аудит
    // ------------------------------------------------------------------

    static String padRight(String s, int width) {
        String result = s;
        while (result.length() < width) {
            result = result + " ";
        }
        return result;
    }

    static void printReport() {
        System.out.println("  === Каталог ===");
        List<String> ids = booksSortedByTitleBubble();
        for (int i = 0; i < ids.size(); i++) {
            String id = ids.get(i);
            String line = "  " + padRight(id, 6);
            line = line + padRight(underscoresToSpaces(bookTitles.get(id)), 14);
            line = line + padRight(underscoresToSpaces(bookAuthors.get(id)), 18);
            line = line + bookYears.get(id) + " ";
            line = line + bookCopies.get(id) + "/" + bookTotalCopies.get(id);
            System.out.println(line);
        }
        System.out.println("  === Участники ===");
        for (int i = 0; i < memberNames.size(); i++) {
            String name = memberNames.get(i);
            String line = "  " + padRight(name, 8);
            line = line + "штраф=" + memberFines.get(i);
            line = line + " книги=" + memberLoans.get(name);
            if (bannedMembers.contains(name)) {
                line = line + " [заблокирован]";
            }
            System.out.println(line);
        }
    }

    static int countEvents(String type) {
        int count = 0;
        for (int i = 0; i < eventLog.size(); i++) {
            if (eventLog.get(i).startsWith(type + " ")) {
                count++;
            }
        }
        return count;
    }

    static int recomputeAvailableFromLog() {
        int total = 0;
        for (int i = 0; i < eventLog.size(); i++) {
            String e = eventLog.get(i);
            List<String> t = tokenize(e);
            if (t.get(0).equals("ADD")) {
                total = total + bookTotalCopies.get(t.get(1));
            } else if (t.get(0).equals("BORROW")) {
                total = total - 1;
            } else if (t.get(0).equals("RETURN")) {
                total = total + 1;
            }
        }
        return total;
    }

    static void runAudit() {
        System.out.println("  === Аудит ===");
        int available = availableCopiesTotal();
        int fromLog = recomputeAvailableFromLog();
        System.out.println("  Свободных экземпляров: " + available + ", по журналу: " + fromLog);
        if (available != fromLog) {
            throw new IllegalStateException("Журнал не сходится с остатками");
        }
        int borrowed = countEvents("BORROW");
        int returned = countEvents("RETURN");
        System.out.println("  Выдач: " + borrowed + ", возвратов: " + returned + ", на руках: " + totalLoansNow());
        if (borrowed - returned != totalLoansNow()) {
            throw new IllegalStateException("Число выдач не сходится");
        }
        System.out.println("  Штрафов всего: " + totalFines() + ", больше всех у: " + richestDebtor());
        System.out.println("  Дубликаты названий: " + findDuplicateTitles());
        System.out.println("  Экземпляров по авторам: " + copiesByAuthor());
        System.out.println("  Самая старая книга: " + oldestBookYear() + " год");
    }

    // ------------------------------------------------------------------
    // Демонстрации коллекций и исключений
    // ------------------------------------------------------------------

    static void immutableCollectionsDemo() {
        List<String> fixed = List.of("a", "b", "c");
        Set<Integer> numbers = Set.of(1, 2, 3);
        Map<String, Integer> pairs = Map.of("x", 1);
        System.out.println("Неизменяемые: " + fixed + " " + numbers.size() + " " + pairs);
        try {
            fixed.add("d");
        } catch (UnsupportedOperationException e) {
            System.out.println("Поймано UnsupportedOperationException при добавлении");
        }
    }

    static void concurrentModificationDemo() {
        List<String> names = new ArrayList<>(memberNames);
        try {
            for (String n : names) {
                if (n.equals("bob")) {
                    names.remove(n);
                }
            }
            System.out.println("Модификация прошла без ошибки");
        } catch (ConcurrentModificationException e) {
            System.out.println("Поймано ConcurrentModificationException");
        }
    }

    static void linkedCollectionsDemo() {
        Map<String, Integer> ordered = new LinkedHashMap<>();
        ordered.put("zeta", 3);
        ordered.put("alpha", 1);
        ordered.put("mid", 2);
        String keys = "";
        for (Map.Entry<String, Integer> entry : ordered.entrySet()) {
            keys = keys + entry.getKey() + "=" + entry.getValue() + ";";
        }
        System.out.println("Порядок вставки сохранён: " + keys);
        Set<String> uniqueAuthors = new LinkedHashSet<>();
        List<String> ids = new ArrayList<>(bookAuthors.keySet());
        Collections.sort(ids);
        for (int i = 0; i < ids.size(); i++) {
            uniqueAuthors.add(bookAuthors.get(ids.get(i)));
        }
        System.out.println("Авторов: " + uniqueAuthors.size());
        List<String> copy = new ArrayList<>(uniqueAuthors);
        Collections.reverse(copy);
        System.out.println("В обратном порядке: " + copy.get(0));
    }

    static void optionalDemo() {
        Optional<String> found = findBookIdOptional("Dune");
        System.out.println("Dune: " + found.isPresent() + " -> " + found.orElse("нет"));
        Optional<String> missing = findBookIdOptional("Missing");
        System.out.println("Missing: " + missing.isPresent() + " -> " + missing.orElse("нет"));
    }

    static void chainedExceptionDemo() {
        try {
            try {
                Integer.parseInt("12x");
            } catch (NumberFormatException e) {
                throw new LibraryException("Ошибка разбора числа", e);
            }
        } catch (LibraryException e) {
            System.out.println("Верхнее: " + e.getMessage());
            Throwable cause = e.getCause();
            System.out.println("Причина: " + cause.getClass().getSimpleName());
            System.out.println("Стек не пуст: " + (e.getStackTrace().length > 0));
        }
        Exception primary = new IllegalStateException("основное");
        primary.addSuppressed(new RuntimeException("подавленное"));
        System.out.println("Подавленных: " + primary.getSuppressed().length);
    }

    static void scannerErrorsDemo() {
        Scanner local = new Scanner("12 abc");
        int first = local.nextInt();
        System.out.println("Первое число: " + first);
        try {
            local.nextInt();
        } catch (InputMismatchException e) {
            System.out.println("Поймано InputMismatchException");
        }
        local.next();
        try {
            local.next();
        } catch (java.util.NoSuchElementException e) {
            System.out.println("Поймано NoSuchElementException");
        }
    }

    static void formatDemo() {
        String line = String.format("%-8s|%5d|%s", "итого", availableCopiesTotal(), "шт");
        System.out.println(line);
        System.out.printf("Выдано %d из %d экземпляров%n", totalCopiesAll() - availableCopiesTotal(), totalCopiesAll());
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 5; i++) {
            sb.append(i).append(',');
        }
        sb.setLength(sb.length() - 1);
        System.out.println("StringBuilder: " + sb.toString());
    }

    static int readRounds(Scanner scanner) {
        System.out.print("Сколько раз прогнать сценарий (1..3, по умолчанию 1): ");
        if (scanner.hasNextInt()) {
            int rounds = scanner.nextInt();
            if (rounds >= 1 && rounds <= 3) {
                return rounds;
            }
        }
        return 1;
    }

    static void resetState() {
        bookTitles.clear();
        bookAuthors.clear();
        bookYears.clear();
        bookCopies.clear();
        bookTotalCopies.clear();
        memberNames.clear();
        memberFines.clear();
        memberLoans.clear();
        bannedMembers.clear();
        eventLog.clear();
    }

    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        int rounds = readRounds(scanner);
        for (int round = 1; round <= rounds; round++) {
            System.out.println("##### Прогон " + round + " #####");
            resetState();
            processScript(SCRIPT);
            System.out.println("Событий в журнале: " + eventLog.size());
        }
        System.out.println();
        System.out.println("##### Демонстрации #####");
        immutableCollectionsDemo();
        concurrentModificationDemo();
        linkedCollectionsDemo();
        optionalDemo();
        chainedExceptionDemo();
        scannerErrorsDemo();
        formatDemo();
        System.out.println();
        System.out.println("Команд обработано: " + commandsProcessed);
        System.out.println("Линейных шагов: " + linearSteps);
        System.out.println("Ошибки по типам: " + errorStats);
        System.out.println("Готово");
    }
}
