export const sampleSource = `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in);
        int target = input.hasNextInt() ? input.nextInt() : 7;
        int[] values = {3, 7, 12, 7, 21};
        int result = find(values, target);
        System.out.println(result);
    }

    static int find(int[] values, int target) {
        for (int i = 0; i < values.length; i++) {
            if (values[i] == target) {
                return i;
            }
        }
        return -1;
    }
}
`;
