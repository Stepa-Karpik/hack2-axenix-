public class OpaqueFinally {
    static int evaluate() {
        try {
            return 1;
        } finally {
            System.out.println("Сохранённый finally");
        }
    }
}
