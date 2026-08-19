import requests

def fetch_and_process_data(url):
    """Fetches data from a given URL and processes it."""
    try:
        # 1. Fetch data using requests library
        response = requests.get(url)
        
        # 2. Check for successful response status code
        response.raise_for_status() # Raises an HTTPError if the status is 4xx or 5xx
        
        # 3. Parse JSON data
        data = response.json()
        
        print("--- Data Fetching Successful ---")
        print(f"Status Code: {response.status_code}")
        
        # 4. Process and display specific information (assuming the structure of jsonplaceholder/todos/1)
        if 'title' in data and 'completed' in data:
            print(f"Title: {data['title']}")
            print(f"Completed Status: {'Yes' if data['completed'] else 'No'}")
        else:
            print("Could not find expected keys (title or completed) in the response.")

    except requests.exceptions.HTTPError as errh:
        print(f"Http Error occurred: {errh}")
    except requests.exceptions.ConnectionError as errc:
        print(f"Error Connecting: {errc}")
    except requests.exceptions.Timeout as errt:
        print(f"Timeout Error: {errt}")
    except requests.exceptions.RequestException as err:
        print(f"An unexpected error occurred: {err}")

if __name__ == "__main__":
    # Using a public placeholder API endpoint for demonstration
    API_URL = "https://jsonplaceholder.typicode.com/todos/1"
    fetch_and_process_data(API_URL)
