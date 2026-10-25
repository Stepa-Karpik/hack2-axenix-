import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Scanner;
import java.util.Set;
import java.util.TreeMap;

/**
 * Тестовая программа №1: анализ текста.
 */
public class TextAnalyzerMess {

    static String[] SENTENCES = {
        "The quick brown fox jumps over the lazy dog",
        "A level of detail was noticed by the radar operator",
        "Listen to the silent night while we enlist new names",
        "Never odd or even said the madam to the civic racecar",
        "Programs must be written for people to read and only incidentally for machines",
        "The stone was set in the tones of the notes",
        "Dormitory and dirty room are not the same thing but sound alike",
        "In 2024 we processed 42 requests and 7 failed while 1000 passed",
        "Code 007 was reviewed by 3 teams and 15 engineers",
        "Simple is better than complex and complex is better than complicated",
        "Rats live on no evil star said the old wise owl",
        "Errors should never pass silently unless explicitly silenced"
    };

    static String globalText = "";
    static List<String> allWords = new ArrayList<>();
    static List<String> uniqueWords = new ArrayList<>();
    static List<Integer> uniqueCounts = new ArrayList<>();
    static int operationsCounter = 0;
    static int errorsCounter = 0;
    static int debugCounter = 0;

    // ------------------------------------------------------------------
    // Построение исходного текста
    // ------------------------------------------------------------------

    static void buildText(int repeat) {
        globalText = "";
        for (int r = 0; r < repeat; r++) {
            for (int i = 0; i < SENTENCES.length; i++) {
                globalText = globalText + SENTENCES[i];
                globalText = globalText + ". ";
                operationsCounter++;
            }
        }
    }

    static String toLowerSlow(String s) {
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

    static String toUpperSlow(String s) {
        String result = "";
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 'a' && c <= 'z') {
                c = (char) (c - 32);
            }
            result = result + c;
        }
        return result;
    }

    static boolean isLetter(char c) {
        if (c >= 'a' && c <= 'z') {
            return true;
        }
        if (c >= 'A' && c <= 'Z') {
            return true;
        }
        return false;
    }

    static boolean isDigit(char c) {
        String digits = "0123456789";
        for (int i = 0; i < digits.length(); i++) {
            if (digits.charAt(i) == c) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Разбиение на слова посимвольно
    // ------------------------------------------------------------------

    static List<String> splitWordsSlow(String text) {
        List<String> words = new ArrayList<>();
        String word = "";
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (isLetter(c) || isDigit(c)) {
                word = word + c;
            } else {
                if (word.length() > 0) {
                    words.add(toLowerSlow(word));
                    word = "";
                }
            }
        }
        if (word.length() > 0) {
            words.add(toLowerSlow(word));
        }
        return words;
    }

    // ------------------------------------------------------------------
    // Частоты слов
    // ------------------------------------------------------------------

    static int indexOfWord(List<String> list, String word) {
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).equals(word)) {
                return i;
            }
        }
        return -1;
    }

    static void countWordsLinear(List<String> words) {
        uniqueWords.clear();
        uniqueCounts.clear();
        for (int i = 0; i < words.size(); i++) {
            String w = words.get(i);
            int idx = indexOfWord(uniqueWords, w);
            if (idx == -1) {
                uniqueWords.add(w);
                uniqueCounts.add(1);
            } else {
                int old = uniqueCounts.get(idx);
                uniqueCounts.set(idx, old + 1);
            }
            operationsCounter++;
        }
    }

    static void sortByCountBubble() {
        int n = uniqueWords.size();
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < n - 1; j++) {
                int a = uniqueCounts.get(j);
                int b = uniqueCounts.get(j + 1);
                boolean swap = false;
                if (a < b) {
                    swap = true;
                } else if (a == b) {
                    if (uniqueWords.get(j).compareTo(uniqueWords.get(j + 1)) > 0) {
                        swap = true;
                    }
                }
                if (swap) {
                    String tw = uniqueWords.get(j);
                    uniqueWords.set(j, uniqueWords.get(j + 1));
                    uniqueWords.set(j + 1, tw);
                    int tc = uniqueCounts.get(j);
                    uniqueCounts.set(j, uniqueCounts.get(j + 1));
                    uniqueCounts.set(j + 1, tc);
                }
                operationsCounter++;
            }
        }
    }

    static void printTop(int k) {
        System.out.println("--- Топ-" + k + " слов ---");
        for (int i = 0; i < k && i < uniqueWords.size(); i++) {
            System.out.println((i + 1) + ". " + uniqueWords.get(i) + " = " + uniqueCounts.get(i));
        }
    }

    // ------------------------------------------------------------------
    // Палиндромы
    // ------------------------------------------------------------------

    static String reverseSlow(String s) {
        String result = "";
        for (int i = s.length() - 1; i >= 0; i--) {
            result = result + s.charAt(i);
        }
        return result;
    }

    static boolean isPalindromeSlow(String s) {
        String reversed = reverseSlow(s);
        if (reversed.length() != s.length()) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            if (reversed.charAt(i) != s.charAt(i)) {
                return false;
            }
        }
        return true;
    }

    static List<String> findPalindromes(List<String> words) {
        List<String> result = new ArrayList<>();
        for (int i = 0; i < words.size(); i++) {
            String w = words.get(i);
            if (w.length() > 2 && isPalindromeSlow(w)) {
                if (indexOfWord(result, w) == -1) {
                    result.add(w);
                }
            }
        }
        return result;
    }

    static boolean isPhrasePalindrome(String phrase) {
        String cleaned = "";
        for (int i = 0; i < phrase.length(); i++) {
            char c = phrase.charAt(i);
            if (isLetter(c)) {
                cleaned = cleaned + c;
            }
        }
        cleaned = toLowerSlow(cleaned);
        return isPalindromeSlow(cleaned);
    }

    // ------------------------------------------------------------------
    // Анаграммы
    // ------------------------------------------------------------------

    static String sortCharsSelection(String s) {
        char[] arr = s.toCharArray();
        for (int i = 0; i < arr.length; i++) {
            int minIdx = i;
            for (int j = i + 1; j < arr.length; j++) {
                if (arr[j] < arr[minIdx]) {
                    minIdx = j;
                }
            }
            char tmp = arr[i];
            arr[i] = arr[minIdx];
            arr[minIdx] = tmp;
        }
        String result = "";
        for (int i = 0; i < arr.length; i++) {
            result = result + arr[i];
        }
        return result;
    }

    static boolean areAnagrams(String a, String b) {
        if (a.length() != b.length()) {
            return false;
        }
        if (a.equals(b)) {
            return false;
        }
        String sa = sortCharsSelection(a);
        String sb = sortCharsSelection(b);
        return sa.equals(sb);
    }

    static List<String> findAnagramPairs(List<String> words) {
        List<String> pairs = new ArrayList<>();
        for (int i = 0; i < words.size(); i++) {
            for (int j = 0; j < words.size(); j++) {
                if (i != j && areAnagrams(words.get(i), words.get(j))) {
                    String pair = words.get(i) + "-" + words.get(j);
                    String reverse = words.get(j) + "-" + words.get(i);
                    if (indexOfWord(pairs, pair) == -1 && indexOfWord(pairs, reverse) == -1) {
                        pairs.add(pair);
                    }
                }
            }
        }
        return pairs;
    }

    // ------------------------------------------------------------------
    // Шифр Цезаря
    // ------------------------------------------------------------------

    static String caesar(String s, int shift) {
        if (shift < 0 || shift > 25) {
            throw new IllegalArgumentException("Сдвиг вне диапазона: " + shift);
        }
        String result = "";
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 'a' && c <= 'z') {
                int pos = c - 'a';
                pos = (pos + shift) % 26;
                result = result + (char) ('a' + pos);
            } else if (c >= 'A' && c <= 'Z') {
                int pos = c - 'A';
                pos = (pos + shift) % 26;
                result = result + (char) ('A' + pos);
            } else {
                result = result + c;
            }
        }
        return result;
    }

    static String caesarDecode(String s, int shift) {
        return caesar(s, 26 - shift);
    }

    static int verifyCaesarForAllWords(List<String> words) {
        int failures = 0;
        for (int shift = 0; shift <= 25; shift++) {
            for (int i = 0; i < words.size(); i++) {
                String w = words.get(i);
                String enc = caesar(w, shift);
                String dec = caesarDecode(enc, shift);
                if (!dec.equals(w)) {
                    failures++;
                }
            }
        }
        return failures;
    }

    // ------------------------------------------------------------------
    // Статистика букв
    // ------------------------------------------------------------------

    static int countVowels(String text) {
        int count = 0;
        for (int i = 0; i < text.length(); i++) {
            String ch = "" + text.charAt(i);
            String lower = toLowerSlow(ch);
            if ("aeiou".indexOf(lower) >= 0) {
                count++;
            }
        }
        return count;
    }

    static int countConsonants(String text) {
        int count = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (isLetter(c)) {
                String ch = "" + c;
                String lower = toLowerSlow(ch);
                if ("aeiou".indexOf(lower) < 0) {
                    count++;
                }
            }
        }
        return count;
    }

    static int[] letterFrequencySlow(String text) {
        int[] freq = new int[26];
        for (int letter = 0; letter < 26; letter++) {
            char target = (char) ('a' + letter);
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (c >= 'A' && c <= 'Z') {
                    c = (char) (c + 32);
                }
                if (c == target) {
                    freq[letter]++;
                }
            }
        }
        return freq;
    }

    static void printLetterFrequency(int[] freq) {
        System.out.println("--- Частоты букв ---");
        for (int i = 0; i < freq.length; i++) {
            if (freq[i] > 0) {
                String bar = "";
                int len = freq[i] / 20;
                for (int k = 0; k < len; k++) {
                    bar = bar + "#";
                }
                System.out.println((char) ('a' + i) + " " + freq[i] + " " + bar);
            }
        }
    }

    static char mostFrequentLetter(int[] freq) {
        int best = 0;
        for (int i = 1; i < freq.length; i++) {
            if (freq[i] > freq[best]) {
                best = i;
            }
        }
        return (char) ('a' + best);
    }

    // ------------------------------------------------------------------
    // Дубликаты и уникальные слова
    // ------------------------------------------------------------------

    static List<String> removeDuplicatesNested(List<String> words) {
        List<String> result = new ArrayList<>();
        for (int i = 0; i < words.size(); i++) {
            boolean found = false;
            for (int j = 0; j < result.size(); j++) {
                if (result.get(j).equals(words.get(i))) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                result.add(words.get(i));
            }
        }
        return result;
    }

    static int countUniqueByHashSet(List<String> words) {
        Set<String> set = new HashSet<>();
        for (int i = 0; i < words.size(); i++) {
            set.add(words.get(i));
        }
        return set.size();
    }

    // ------------------------------------------------------------------
    // Гистограмма длин слов
    // ------------------------------------------------------------------

    static int[][] wordLengthTable(List<String> words) {
        int[][] table = new int[20][2];
        for (int len = 0; len < 20; len++) {
            table[len][0] = len;
            table[len][1] = 0;
        }
        for (int i = 0; i < words.size(); i++) {
            for (int len = 0; len < 20; len++) {
                if (words.get(i).length() == len) {
                    table[len][1] = table[len][1] + 1;
                }
            }
        }
        return table;
    }

    static void printLengthTable(int[][] table) {
        System.out.println("--- Длины слов ---");
        for (int i = 0; i < table.length; i++) {
            if (table[i][1] > 0) {
                System.out.println("длина " + table[i][0] + ": " + table[i][1]);
            }
        }
    }

    static String longestWordBySorting(List<String> words) {
        List<String> copy = new ArrayList<>();
        for (int i = 0; i < words.size(); i++) {
            copy.add(words.get(i));
        }
        for (int i = 0; i < copy.size(); i++) {
            for (int j = 0; j < copy.size() - 1; j++) {
                if (copy.get(j).length() < copy.get(j + 1).length()) {
                    String t = copy.get(j);
                    copy.set(j, copy.get(j + 1));
                    copy.set(j + 1, t);
                }
            }
        }
        return copy.get(0);
    }

    static double averageWordLength(List<String> words) {
        int total = 0;
        for (int i = 0; i < words.size(); i++) {
            total = total + words.get(i).length();
        }
        return (double) total / words.size();
    }

    // ------------------------------------------------------------------
    // Биграммы
    // ------------------------------------------------------------------

    static void bigramStats(List<String> words) {
        List<String> bigrams = new ArrayList<>();
        List<Integer> counts = new ArrayList<>();
        for (int i = 0; i + 1 < words.size(); i++) {
            String bg = words.get(i) + " " + words.get(i + 1);
            int idx = -1;
            for (int j = 0; j < bigrams.size(); j++) {
                if (bigrams.get(j).equals(bg)) {
                    idx = j;
                    break;
                }
            }
            if (idx == -1) {
                bigrams.add(bg);
                counts.add(1);
            } else {
                counts.set(idx, counts.get(idx) + 1);
            }
        }
        int bestIdx = 0;
        for (int i = 1; i < bigrams.size(); i++) {
            if (counts.get(i) > counts.get(bestIdx)) {
                bestIdx = i;
            }
        }
        System.out.println("Уникальных биграмм: " + bigrams.size());
        System.out.println("Самая частая биграмма: " + bigrams.get(bestIdx) + " (" + counts.get(bestIdx) + ")");
    }

    // ------------------------------------------------------------------
    // Сжатие RLE
    // ------------------------------------------------------------------

    static String rleEncode(String s) {
        if (s.length() == 0) {
            return "";
        }
        String result = "";
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            int count = 1;
            while (i + count < s.length() && s.charAt(i + count) == c) {
                count++;
            }
            result = result + c + count;
            i = i + count;
        }
        return result;
    }

    static String rleDecode(String s) {
        String result = "";
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            i++;
            String num = "";
            while (i < s.length() && isDigit(s.charAt(i))) {
                num = num + s.charAt(i);
                i++;
            }
            int count = Integer.parseInt(num);
            for (int k = 0; k < count; k++) {
                result = result + c;
            }
        }
        return result;
    }

    // ------------------------------------------------------------------
    // Числа в тексте: управление потоком через исключения
    // ------------------------------------------------------------------

    static int sumNumbersInTokens(List<String> tokens) {
        int sum = 0;
        for (int i = 0; i < tokens.size(); i++) {
            try {
                int value = Integer.parseInt(tokens.get(i));
                sum = sum + value;
            } catch (NumberFormatException e) {
                errorsCounter++;
            }
        }
        return sum;
    }

    static int countNumericTokens(List<String> tokens) {
        int count = 0;
        for (int i = 0; i < tokens.size(); i++) {
            try {
                Integer.parseInt(tokens.get(i));
                count++;
            } catch (Exception e) {
                // игнорируем
            }
        }
        return count;
    }

    static int safeCharAtSum(String s, int upTo) {
        int sum = 0;
        for (int i = 0; i < upTo; i++) {
            try {
                sum = sum + s.charAt(i);
            } catch (StringIndexOutOfBoundsException e) {
                errorsCounter++;
                break;
            }
        }
        return sum;
    }

    // ------------------------------------------------------------------
    // Поиск подстроки и хеш
    // ------------------------------------------------------------------

    static int countOccurrencesNaive(String text, String pattern) {
        if (pattern.length() == 0) {
            throw new IllegalArgumentException("Пустой шаблон");
        }
        int count = 0;
        for (int i = 0; i <= text.length() - pattern.length(); i++) {
            String piece = text.substring(i, i + pattern.length());
            if (piece.equals(pattern)) {
                count++;
            }
        }
        return count;
    }

    static int simpleHash(String s) {
        int hash = 7;
        for (int i = 0; i < s.length(); i++) {
            hash = (hash * 31 + s.charAt(i)) % 1000003;
        }
        return hash;
    }

    static int totalHashOfAllWords(List<String> words) {
        int total = 0;
        for (int i = 0; i < words.size(); i++) {
            total = (total + simpleHash(words.get(i))) % 1000003;
        }
        return total;
    }

    static int countCollisions(List<String> uniq) {
        int collisions = 0;
        for (int i = 0; i < uniq.size(); i++) {
            for (int j = i + 1; j < uniq.size(); j++) {
                if (simpleHash(uniq.get(i)) % 64 == simpleHash(uniq.get(j)) % 64) {
                    collisions++;
                }
            }
        }
        return collisions;
    }

    // ------------------------------------------------------------------
    // Предложения
    // ------------------------------------------------------------------

    static List<String> splitSentences(String text) {
        List<String> result = new ArrayList<>();
        String rest = text;
        while (rest.indexOf(". ") >= 0) {
            int idx = rest.indexOf(". ");
            result.add(rest.substring(0, idx));
            rest = rest.substring(idx + 2);
        }
        if (rest.length() > 0) {
            result.add(rest);
        }
        return result;
    }

    static String capitalizeWords(String sentence) {
        String result = "";
        boolean newWord = true;
        for (int i = 0; i < sentence.length(); i++) {
            char c = sentence.charAt(i);
            if (newWord && c >= 'a' && c <= 'z') {
                result = result + (char) (c - 32);
            } else {
                result = result + c;
            }
            newWord = (c == ' ');
        }
        return result;
    }

    static int longestSentenceLength(List<String> sentences) {
        int best = 0;
        for (int i = 0; i < sentences.size(); i++) {
            int len = splitWordsSlow(sentences.get(i)).size();
            if (len > best) {
                best = len;
            }
        }
        return best;
    }

    static int countPalindromeSentences(List<String> sentences) {
        int count = 0;
        for (int i = 0; i < sentences.size(); i++) {
            if (isPhrasePalindrome(sentences.get(i))) {
                count++;
            }
        }
        return count;
    }

    // ------------------------------------------------------------------
    // Индекс: слово -> номера предложений
    // ------------------------------------------------------------------

    static Map<String, String> buildIndexSlow(List<String> sentences) {
        Map<String, String> index = new TreeMap<>();
        for (int i = 0; i < sentences.size(); i++) {
            List<String> words = splitWordsSlow(sentences.get(i));
            for (int j = 0; j < words.size(); j++) {
                String w = words.get(j);
                if (index.containsKey(w)) {
                    String old = index.get(w);
                    if (old.indexOf("," + i + ",") < 0 && !old.startsWith(i + ",")) {
                        index.put(w, old + i + ",");
                    }
                } else {
                    index.put(w, i + ",");
                }
            }
        }
        return index;
    }

    static int totalIndexEntries(Map<String, String> index) {
        int total = 0;
        for (String key : index.keySet()) {
            String value = index.get(key);
            for (int i = 0; i < value.length(); i++) {
                if (value.charAt(i) == ',') {
                    total++;
                }
            }
        }
        return total;
    }

    static Map<Integer, Integer> countWordsByLengthMap(List<String> words) {
        Map<Integer, Integer> map = new HashMap<>();
        for (int i = 0; i < words.size(); i++) {
            Integer len = words.get(i).length();
            if (map.get(len) == null) {
                map.put(len, 0);
            }
            map.put(len, map.get(len) + 1);
        }
        return map;
    }

    // ------------------------------------------------------------------
    // Ввод пользователя
    // ------------------------------------------------------------------

    static String readQuery(Scanner scanner) {
        System.out.print("Введите слово для поиска (Enter - значение по умолчанию): ");
        if (scanner.hasNextLine()) {
            String line = scanner.nextLine();
            if (line.length() > 0) {
                return toLowerSlow(line);
            }
        }
        return "the";
    }

    static int readRepeat(Scanner scanner) {
        System.out.print("Сколько раз повторить исходный текст (по умолчанию 20): ");
        if (scanner.hasNextInt()) {
            int value = scanner.nextInt();
            if (scanner.hasNextLine()) {
                scanner.nextLine();
            }
            if (value > 0 && value <= 200) {
                return value;
            }
        }
        return 20;
    }

    // ------------------------------------------------------------------
    // Проверки и отчёт
    // ------------------------------------------------------------------

    static void checkInvariants() {
        int sumOfCounts = 0;
        for (int i = 0; i < uniqueCounts.size(); i++) {
            sumOfCounts = sumOfCounts + uniqueCounts.get(i);
        }
        if (sumOfCounts != allWords.size()) {
            throw new IllegalStateException("Сумма частот не равна числу слов");
        }
        if (uniqueWords.size() != countUniqueByHashSet(allWords)) {
            throw new IllegalStateException("Число уникальных слов не совпадает");
        }
        System.out.println("Инварианты проверены");
    }

    static void printSeparator() {
        String line = "";
        for (int i = 0; i < 40; i++) {
            line = line + "=";
        }
        System.out.println(line);
    }

    static void demonstrateErrors() {
        System.out.println("--- Демонстрация исключений ---");
        try {
            caesar("hello", 99);
        } catch (IllegalArgumentException e) {
            System.out.println("Поймано: " + e.getMessage());
        }
        try {
            countOccurrencesNaive("abc", "");
        } catch (IllegalArgumentException e) {
            System.out.println("Поймано: " + e.getMessage());
        }
        try {
            String s = null;
            System.out.println(s.length());
        } catch (NullPointerException e) {
            System.out.println("Поймано NullPointerException");
        }
        try {
            int[] arr = new int[3];
            arr[5] = 1;
        } catch (ArrayIndexOutOfBoundsException e) {
            System.out.println("Поймано ArrayIndexOutOfBoundsException");
        }
        try {
            Object o = "text";
            Integer x = (Integer) o;
            System.out.println(x);
        } catch (ClassCastException e) {
            System.out.println("Поймано ClassCastException");
        } finally {
            System.out.println("finally выполнен");
        }
    }

    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        int repeat = readRepeat(scanner);
        String query = readQuery(scanner);

        buildText(repeat);
        System.out.println("Длина текста: " + globalText.length());
        allWords = splitWordsSlow(globalText);
        System.out.println("Всего слов: " + allWords.size());
        printSeparator();

        countWordsLinear(allWords);
        sortByCountBubble();
        System.out.println("Уникальных слов: " + uniqueWords.size());
        printTop(10);
        checkInvariants();
        printSeparator();

        List<String> uniq = removeDuplicatesNested(allWords);
        System.out.println("Уникальных (вложенные циклы): " + uniq.size());
        List<String> palindromes = findPalindromes(uniq);
        System.out.println("Палиндромы: " + palindromes);
        List<String> pairs = findAnagramPairs(uniq);
        System.out.println("Пар анаграмм: " + pairs.size());
        for (int i = 0; i < pairs.size() && i < 5; i++) {
            System.out.println("  " + pairs.get(i));
        }
        printSeparator();

        System.out.println("Гласных: " + countVowels(globalText));
        System.out.println("Согласных: " + countConsonants(globalText));
        int[] freq = letterFrequencySlow(globalText);
        printLetterFrequency(freq);
        System.out.println("Самая частая буква: " + mostFrequentLetter(freq));
        printSeparator();

        printLengthTable(wordLengthTable(allWords));
        System.out.println("Самое длинное слово: " + longestWordBySorting(allWords));
        System.out.println("Средняя длина слова: " + averageWordLength(allWords));
        bigramStats(allWords);
        printSeparator();

        String sample = "aaabbbccccddddddeffff";
        String encoded = rleEncode(sample);
        System.out.println("RLE: " + encoded + " -> " + rleDecode(encoded));
        String enc = caesar("Hello World", 3);
        System.out.println("Цезарь: " + enc + " -> " + caesarDecode(enc, 3));
        System.out.println("Ошибок в проверке шифра: " + verifyCaesarForAllWords(uniq));
        printSeparator();

        List<String> numbers = new ArrayList<>();
        for (int i = 0; i < allWords.size() && i < 200; i++) {
            numbers.add(allWords.get(i));
        }
        System.out.println("Числовых токенов: " + countNumericTokens(numbers));
        System.out.println("Сумма чисел: " + sumNumbersInTokens(allWords));
        System.out.println("Сумма кодов символов: " + safeCharAtSum("hello", 10));
        printSeparator();

        System.out.println("Вхождений '" + query + "': " + countOccurrencesNaive(toLowerSlow(globalText), query));
        System.out.println("Хеш всех слов: " + totalHashOfAllWords(allWords));
        System.out.println("Коллизий (64 корзины): " + countCollisions(uniq));
        printSeparator();

        List<String> sentences = splitSentences(globalText);
        System.out.println("Предложений: " + sentences.size());
        System.out.println("Самое длинное предложение, слов: " + longestSentenceLength(sentences));
        System.out.println("Предложений-палиндромов: " + countPalindromeSentences(sentences));
        System.out.println(capitalizeWords("simple is better than complex"));
        Map<String, String> index = buildIndexSlow(sentences);
        System.out.println("Записей в индексе: " + index.size() + ", ссылок: " + totalIndexEntries(index));
        Map<Integer, Integer> byLength = countWordsByLengthMap(allWords);
        System.out.println("Разных длин слов: " + byLength.size());
        printSeparator();

        demonstrateErrors();
        System.out.println("Операций выполнено: " + operationsCounter);
        System.out.println("Ошибок поймано: " + errorsCounter);
        System.out.println("Готово");
    }
}
