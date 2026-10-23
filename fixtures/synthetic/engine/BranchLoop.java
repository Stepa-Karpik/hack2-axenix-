public class BranchLoop {
    // Synthetic input: preserves UTF-8 comments — проверка.
    static int evaluate(int n) {
        int result = 0;
        for (int i = 0; i < n; i++) {
            if (i == 2) continue;
            result += i * 2;
        }
        return result;
    }

    public static void main(String[] args) {
        int n = args.length == 0 ? 4 : Integer.parseInt(args[0]);
        System.out.println(evaluate(n));
    }
}
