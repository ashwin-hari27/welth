import os
import pickle
import subprocess
import hashlib

API_KEY = "sk-live-1234567890abcdef"


def run_command(user_input):
    os.system("ls " + user_input)
    subprocess.run(user_input, shell=True)


def calculate(expr):
    return eval(expr)


def load_data(blob):
    return pickle.loads(blob)


def find_user(cursor, name):
    cursor.execute(f"SELECT * FROM users WHERE name = '{name}'")


def hash_password(pw):
    return hashlib.md5(pw.encode()).hexdigest()


def messy(a, b, c, d):
    if a:
        if b:
            for i in range(10):
                if i % 2 == 0 and c:
                    d += 1
                elif i % 3 == 0 or d:
                    d -= 1
                while d > 100:
                    d -= 1
                    if d == 50:
                        break
    return d
